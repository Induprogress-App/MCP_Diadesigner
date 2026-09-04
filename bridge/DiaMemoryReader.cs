using Microsoft.Diagnostics.Runtime;
using System;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Collections.Generic;

// Reads a DIADesigner process's decrypted Ladder program straight out of its
// managed heap with ClrMD (read-only attach). DIADesigner keeps program logic
// AES-encrypted on disk, but once a project is open the objects are in memory in
// the clear. The classes we read (IspProject.*) are the ISP converter's grid
// form of every network: NetWorkData holds a comment and an iList of elements
// (ContactData / CoilData / LinkData / SpaceData, plus BranchData -- a nested
// row/column grid that represents either a parallel OR branch or, when
// type=="fb", a single function-block instance such as a "=" / "<>" compare).
//
// A branch's grid is read row-by-row: within one row, elements at increasing
// column indices are in series (AND); the branch's rows are alternatives
// (OR). SpaceData ("verticalLine") cells are pure layout filler and carry no
// logic. An "fb" branch is not itself an OR of rows -- its 1-column, 3-row
// grid holds the block's own anatomy: an InVariablesMacro (operand pins, each
// an InVariable with a localID and an "expression" string), the Block itself
// (typeName is the operator, e.g. "=" or "<>"), and an OutVariablesMacro.
//
// Each network is emitted as a "coil" (or null if none was found), a
// "storage" mode (none/set/reset) and a "terms" array: the trunk's AND-chain,
// where each term is one of:
//   {"t":"contact","var":...,"negated":true,"edge":"rising"}
//   {"t":"compare","op":"=","lhs":"...","rhs":"..."}
//   {"t":"or","rows":[[term,...],[term,...]]}
//   {"t":"unknown","desc":"..."}                  -- something we could not
//                                                     resolve; surfaced
//                                                     rather than silently
//                                                     dropped.
public class DiaMemoryReader {
  static MethodInfo _rf = typeof(ClrObject).GetMethod("ReadField");
  static ClrHeap _heap;
  static int _contactCount, _compareCount, _unknownCount;

  static int RInt(ClrObject o, string f){ try { return (int)_rf.MakeGenericMethod(typeof(int)).Invoke(o, new object[]{f}); } catch { return 0; } }
  static bool RBool(ClrObject o, string f){ try { return (bool)_rf.MakeGenericMethod(typeof(bool)).Invoke(o, new object[]{f}); } catch { return false; } }
  static string RStr(ClrObject o, string f){ try { return o.ReadStringField(f) ?? ""; } catch { return ""; } }
  static ClrObject RObj(ClrObject o, string f){ try { return o.ReadObjectField(f); } catch { return default(ClrObject); } }

  static List<ClrObject> ReadList(ClrObject list){
    var res = new List<ClrObject>();
    if (list.IsNull) return res;
    int size = RInt(list, "_size");
    var items = RObj(list, "_items");
    if (items.IsNull || !items.IsArray) return res;
    var arr = items.AsArray();
    for (int i=0;i<size && i<arr.Length;i++){
      try { ulong a=(ulong)arr.GetObjectValue(i); if(a!=0) res.Add(_heap.GetObject(a)); } catch {}
    }
    return res;
  }

  static string J(string s){
    if (s == null) return "";
    var sb = new StringBuilder();
    foreach (char c in s) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.ToString();
  }

  static string ShortTypeName(ClrObject o){
    var tn = o.Type == null ? "" : (o.Type.Name ?? "");
    var i = tn.LastIndexOf('.');
    return i >= 0 ? tn.Substring(i + 1) : tn;
  }

  static readonly HashSet<string> CompareOps = new HashSet<string> { "=", "<>", ">", "<", ">=", "<=" };

  /** Reads an "fb" BranchData's InVariablesMacro + Block into a {"t":"compare",...} term, or "unknown". */
  static string ResolveFbBranch(ClrObject branch){
    ClrObject inMacro = default(ClrObject), block = default(ClrObject);
    var dataArrayField = RObj(branch, "<DataArray>k__BackingField");
    if (!dataArrayField.IsNull && dataArrayField.IsArray) {
      var arr = dataArrayField.AsArray();
      int dim0 = arr.GetLength(0), dim1 = arr.GetLength(1);
      for (int r = 0; r < dim0; r++) {
        for (int c = 0; c < dim1; c++) {
          ClrObject cell;
          try { cell = arr.GetObjectValue(new int[] { r, c }); } catch { continue; }
          if (cell.IsNull) continue;
          var st = ShortTypeName(cell);
          if (st == "InVariablesMacro") inMacro = cell;
          else if (st == "Block") block = cell;
        }
      }
    }
    if (block.IsNull) { _unknownCount++; return "{\"t\":\"unknown\",\"desc\":\"fb branch with no Block found\"}"; }
    string typeName = RStr(block, "typeName");
    if (inMacro.IsNull) {
      _unknownCount++;
      return "{\"t\":\"unknown\",\"desc\":\"Block " + J(typeName) + " has no InVariablesMacro (operands unavailable)\"}";
    }
    var inVars = ReadList(RObj(inMacro, "inVarList"));
    // sort by localID so lhs/rhs come out in the order the block actually wires them
    inVars.Sort((a, b) => RInt(a, "localID").CompareTo(RInt(b, "localID")));
    if (CompareOps.Contains(typeName) && inVars.Count == 2) {
      string lhs = RStr(inVars[0], "expression");
      string rhs = RStr(inVars[1], "expression");
      _compareCount++;
      return "{\"t\":\"compare\",\"op\":\"" + J(typeName) + "\",\"lhs\":\"" + J(lhs) + "\",\"rhs\":\"" + J(rhs) + "\"}";
    }
    // Unsupported operator (e.g. a timer/library FB instance, apiNum != -1) or unexpected
    // operand count -- surface it with what we found instead of guessing.
    _unknownCount++;
    var operands = new StringBuilder();
    for (int i = 0; i < inVars.Count; i++) { if (i>0) operands.Append(", "); operands.Append(RStr(inVars[i], "expression")); }
    return "{\"t\":\"unknown\",\"desc\":\"Block typeName=" + J(typeName).Replace("\"","'") + " apiNum=" + RInt(block,"apiNum") +
           " with " + inVars.Count + " operand(s): " + J(operands.ToString()).Replace("\"","'") + "\"}";
  }

  /** One trunk/row element -> a term string, or null if it carries no logic (Space/Link/Coil). */
  static string ResolveTerm(ClrObject e){
    var st = ShortTypeName(e);
    switch (st) {
      case "ContactData": {
        _contactCount++;
        string v = RStr(e, "variable");
        bool negated = RBool(e, "negated");
        string edge = RStr(e, "edge");
        var sb = new StringBuilder();
        sb.Append("{\"t\":\"contact\",\"var\":\"").Append(J(v)).Append("\"");
        if (negated) sb.Append(",\"negated\":true");
        if (!string.IsNullOrEmpty(edge) && edge != "none") sb.Append(",\"edge\":\"").Append(J(edge)).Append("\"");
        sb.Append("}");
        return sb.ToString();
      }
      case "BranchData": {
        string btype = RStr(e, "type");
        if (btype == "fb") return ResolveFbBranch(e);
        return ResolveOrBranch(e);
      }
      case "SpaceData":
      case "LinkData":
      case "CoilData":
        return null; // layout filler / handled separately
      default:
        _unknownCount++;
        return "{\"t\":\"unknown\",\"desc\":\"unhandled element type " + J(st) + "\"}";
    }
  }

  /** A "normal" BranchData: each grid row is an AND-chain; the rows OR together. */
  static string ResolveOrBranch(ClrObject branch){
    var dataArrayField = RObj(branch, "<DataArray>k__BackingField");
    if (dataArrayField.IsNull || !dataArrayField.IsArray) {
      _unknownCount++;
      return "{\"t\":\"unknown\",\"desc\":\"branch with no DataArray\"}";
    }
    var arr = dataArrayField.AsArray();
    int dim0 = arr.GetLength(0), dim1 = arr.GetLength(1);
    var rows = new List<string>();
    for (int r = 0; r < dim0; r++) {
      var terms = new List<string>();
      for (int c = 0; c < dim1; c++) {
        ClrObject cell;
        try { cell = arr.GetObjectValue(new int[] { r, c }); } catch { continue; }
        if (cell.IsNull) continue;
        var term = ResolveTerm(cell);
        if (term != null) terms.Add(term);
      }
      if (terms.Count > 0) rows.Add("[" + string.Join(",", terms) + "]");
    }
    if (rows.Count == 0) return null; // an all-filler branch carries no logic
    return "{\"t\":\"or\",\"rows\":[" + string.Join(",", rows) + "]}";
  }

  /** Emits one NetWorkData as a JSON object, or null if it has no coil to assign. */
  static string EmitNetwork(ClrObject netObj, out string coilVar){
    coilVar = null;
    var elems = ReadList(RObj(netObj,"iList"));
    string coilStorage = null;
    foreach (var e in elems) {
      if (ShortTypeName(e) == "CoilData") {
        coilVar = RStr(e, "variable");
        coilStorage = RStr(e, "storage");
        break;
      }
    }
    if (coilVar == null || coilVar.Length == 0) return null;

    string comment = RStr(netObj,"comment");
    var terms = new List<string>();
    foreach (var e in elems) {
      var term = ResolveTerm(e);
      if (term != null) terms.Add(term);
    }
    var sb = new StringBuilder();
    sb.Append("{\"comment\":\""+J(comment)+"\",\"coil\":\""+J(coilVar)+"\"");
    if (!string.IsNullOrEmpty(coilStorage) && coilStorage != "none") sb.Append(",\"storage\":\""+J(coilStorage)+"\"");
    sb.Append(",\"terms\":["+string.Join(",", terms)+"]}");
    return sb.ToString();
  }

  static bool IsPlaceholderComment(string c){ return c.Length==0 || c=="Enter comment here…"; }

  /** Finds a live POU object by exact name. Returns its default(ClrObject) (IsNull) if not found. */
  static ClrObject FindPou(string pouName){
    foreach (var obj in _heap.EnumerateObjects()) {
      var t = obj.Type; if (t == null) continue;
      var tn = t.Name; if (tn == null || !tn.EndsWith(".POU")) continue;
      if (RStr(obj, "name") == pouName) return obj;
    }
    return default(ClrObject);
  }

  /** codeBody.codeWorkSheet.graphicCanvasData._networks for a POU, or an empty list if the chain is missing (non-LD POU). */
  static List<ClrObject> PouNetworks(ClrObject pou){
    var codeBody = RObj(pou, "codeBody");
    var ws = RObj(codeBody, "codeWorkSheet");
    var canvas = RObj(ws, "graphicCanvasData");
    return ReadList(RObj(canvas, "_networks"));
  }

  static string PouLanguage(ClrObject pou){
    var codeBody = RObj(pou, "codeBody");
    var ws = RObj(codeBody, "codeWorkSheet");
    if (ws.IsNull) return "";
    // codeLanguage is an enum field; ToString() on the boxed value via reflection is overkill here,
    // so read it as an int and let the caller not worry about it -- the worksheet's own runtime type
    // (e.g. "LDWorkSheet", "STWorkSheet") is a reliable enough language signal.
    return ShortTypeName(ws);
  }

  /** Lists every POU currently resident in memory: name, IEC POU kind, and worksheet type (language signal). */
  public static string ListPous(int pid){
    var sb = new StringBuilder();
    sb.Append("[");
    bool first = true;
    using (var dt = DataTarget.AttachToProcess(pid, false)) {
      _heap = dt.ClrVersions[0].CreateRuntime().Heap;
      var seen = new HashSet<string>();
      foreach (var obj in _heap.EnumerateObjects()) {
        var t = obj.Type; if (t == null) continue;
        var tn = t.Name; if (tn == null || !tn.EndsWith(".POU")) continue;
        string name = RStr(obj, "name");
        if (name.Length == 0 || seen.Contains(name)) continue;
        seen.Add(name);
        int networkCount = PouNetworks(obj).Count;
        if (!first) sb.Append(",");
        first = false;
        sb.Append("{\"name\":\""+J(name)+"\",\"worksheet\":\""+J(PouLanguage(obj))+"\",\"networkCount\":"+networkCount+"}");
      }
    }
    sb.Append("]");
    return sb.ToString();
  }

  public static string Run(int pid, int maxNetworks, bool onlyCommented, string pouName){
    var vars = new SortedSet<string>();
    var nets = new StringBuilder();
    int netCount=0, emitted=0, coilCount=0;
    _contactCount = 0; _compareCount = 0; _unknownCount = 0;
    bool scoped = !string.IsNullOrEmpty(pouName);

    using (var dt = DataTarget.AttachToProcess(pid, false)) {
      _heap = dt.ClrVersions[0].CreateRuntime().Heap;

      if (scoped) {
        // NOTE: true per-POU scoping is not yet implemented. The UI/canvas layer
        // (POU.codeBody.codeWorkSheet.graphicCanvasData._networks) holds the right
        // *count* of networks for a POU but its objects are NetworkCanvasData (a
        // rendering wrapper), not the IspProject.NetWorkData the resolver below
        // understands -- and none of the back-reference fields we've found on that
        // wrapper (CompilerRefGuid, ModelInfo, parentBlock/currentBlock.ParentNetwork,
        // rowData) are populated on an idle document. Refuse rather than silently
        // return an empty or wrong result; use coilPattern on the unscoped scan instead.
        var pou = FindPou(pouName);
        if (pou.IsNull) {
          return "{\"ok\":false,\"error\":\"POU not found in live process: " + J(pouName) + "\"}";
        }
        return "{\"ok\":false,\"error\":\"PouName-scoped extraction is not yet implemented; " +
               "use coilPattern on the unscoped read instead.\",\"pouNetworkCountHint\":" + PouNetworks(pou).Count + "}";
      } else {
        // Backward-compatible whole-heap scan (every resident network, regardless of owning POU).
        foreach (var obj in _heap.EnumerateObjects()) {
          var t=obj.Type; if(t==null) continue;
          var tn=t.Name; if(tn==null) continue;
          if(tn=="DeltaIA.DIAStudio.Programming.Project.IspProject.ContactData"){ var v=RStr(obj,"variable"); if(v.Length>0)vars.Add(v); continue; }
          if(tn=="DeltaIA.DIAStudio.Programming.Project.IspProject.CoilData"){ var v=RStr(obj,"variable"); if(v.Length>0)vars.Add(v); continue; }
          if(tn!="DeltaIA.DIAStudio.Programming.Project.IspProject.NetWorkData") continue;
          if (emitted >= maxNetworks) continue;
          string coilVar;
          string json = EmitNetwork(obj, out coilVar);
          if (json == null) continue;
          string comment = RStr(obj, "comment");
          if (onlyCommented && IsPlaceholderComment(comment)) continue;
          netCount++; coilCount++;
          if (emitted > 0) nets.Append(",");
          nets.Append(json);
          emitted++;
        }
      }
    }

    var vs = new StringBuilder(); bool vf=true;
    foreach(var v in vars){ if(!vf)vs.Append(","); vf=false; vs.Append("\""+J(v)+"\""); }

    var outSb = new StringBuilder();
    outSb.Append("{\"ok\":true,\"pid\":"+pid);
    if (scoped) outSb.Append(",\"pouName\":\""+J(pouName)+"\"");
    outSb.Append(",\"stats\":{\"networksWithLogic\":"+netCount+",\"coils\":"+coilCount+",\"contacts\":"+_contactCount+
                 ",\"compares\":"+_compareCount+",\"unresolved\":"+_unknownCount+",\"uniqueVariables\":"+vars.Count+"}");
    outSb.Append(",\"networksEmitted\":"+emitted);
    outSb.Append(",\"variables\":["+vs+"]");
    outSb.Append(",\"networks\":["+nets+"]}");
    return outSb.ToString();
  }

  static void CollectVars(ClrObject e, SortedSet<string> vars){
    var st = ShortTypeName(e);
    if (st == "ContactData" || st == "CoilData") {
      var v = RStr(e, "variable");
      if (v.Length > 0) vars.Add(v);
    } else if (st == "BranchData") {
      var dataArrayField = RObj(e, "<DataArray>k__BackingField");
      if (!dataArrayField.IsNull && dataArrayField.IsArray) {
        var arr = dataArrayField.AsArray();
        int dim0 = arr.GetLength(0), dim1 = arr.GetLength(1);
        for (int r = 0; r < dim0; r++)
          for (int c = 0; c < dim1; c++) {
            ClrObject cell;
            try { cell = arr.GetObjectValue(new int[] { r, c }); } catch { continue; }
            if (!cell.IsNull) CollectVars(cell, vars);
          }
      }
    } else if (st == "InVariablesMacro") {
      foreach (var iv in ReadList(RObj(e, "inVarList"))) {
        var expr = RStr(iv, "expression");
        // Only literal identifiers look like variable references; numeric literals aren't.
        if (expr.Length > 0 && !char.IsDigit(expr[0]) && expr[0] != '-') vars.Add(expr);
      }
    }
  }
}
