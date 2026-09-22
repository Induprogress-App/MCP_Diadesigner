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
  static int _coilActionCount, _movActionCount, _incActionCount;

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

  /** typeName->apiNum values for known non-boolean "action" blocks (assignment/increment-style),
      distinct from the comparator "fb" blocks ResolveFbBranch understands for conditions. These
      sit at a rung's OUTPUT position (like a coil), not in its condition chain. */
  static bool IsMovBlock(string typeName, int apiNum){ return typeName == "MOV" || apiNum == 190; }
  static bool IsIncBlock(string typeName, int apiNum){ return typeName == "INC" || apiNum == 104; }
  static bool IsDecBlock(string typeName, int apiNum){ return typeName == "DEC" || apiNum == 105; }

  /** Extracts the InVariablesMacro/OutVariablesMacro/Block cells directly inside one "fb"
      BranchData's grid (does not recurse -- an fb branch's own 3-row/1-column grid is always
      flat: operands, the Block, and its outputs). */
  static void GetFbParts(ClrObject branch, out ClrObject inMacro, out ClrObject outMacro, out ClrObject block){
    inMacro = default(ClrObject); outMacro = default(ClrObject); block = default(ClrObject);
    var dataArrayField = RObj(branch, "<DataArray>k__BackingField");
    if (dataArrayField.IsNull || !dataArrayField.IsArray) return;
    var arr = dataArrayField.AsArray();
    int dim0 = arr.GetLength(0), dim1 = arr.GetLength(1);
    for (int r = 0; r < dim0; r++) for (int c = 0; c < dim1; c++) {
      ClrObject cell; try { cell = arr.GetObjectValue(new int[]{r,c}); } catch { continue; }
      if (cell.IsNull) continue;
      var cst = ShortTypeName(cell);
      if (cst == "InVariablesMacro") inMacro = cell;
      else if (cst == "OutVariablesMacro") outMacro = cell;
      else if (cst == "Block") block = cell;
    }
  }

  /** All (row, [non-null cells]) pairs of a BranchData's grid, in row order. */
  static List<List<ClrObject>> GetGridRows(ClrObject branch){
    var rows = new List<List<ClrObject>>();
    var dataArrayField = RObj(branch, "<DataArray>k__BackingField");
    if (dataArrayField.IsNull || !dataArrayField.IsArray) return rows;
    var arr = dataArrayField.AsArray();
    int dim0 = arr.GetLength(0), dim1 = arr.GetLength(1);
    for (int r = 0; r < dim0; r++) {
      var row = new List<ClrObject>();
      for (int c = 0; c < dim1; c++) {
        ClrObject cell; try { cell = arr.GetObjectValue(new int[]{r,c}); } catch { continue; }
        if (!cell.IsNull) row.Add(cell);
      }
      if (row.Count > 0) rows.Add(row);
    }
    return rows;
  }

  static string BuildActionJson(string comment, string coil, string storage, string movValue, int? delta, List<string> terms){
    var sb = new StringBuilder();
    sb.Append("{\"comment\":\""+J(comment)+"\",\"coil\":\""+J(coil)+"\"");
    if (!string.IsNullOrEmpty(storage) && storage != "none") sb.Append(",\"storage\":\""+J(storage)+"\"");
    if (movValue != null) sb.Append(",\"movValue\":\""+J(movValue)+"\"");
    if (delta.HasValue) sb.Append(",\"delta\":"+delta.Value);
    sb.Append(",\"terms\":["+string.Join(",", terms)+"]}");
    return sb.ToString();
  }

  /**
   * Walks one nesting level of a network's elements, left to right, accumulating boolean
   * condition terms (contacts, compares, OR-branches) into `pathTerms` as it goes -- exactly
   * like the old single-coil AND-chain did -- but whenever it meets an *action* (a CoilData, or
   * an "fb" Block that assigns rather than compares: MOV/INC/DEC), it emits that action gated by
   * the terms accumulated *so far*, instead of stopping at the first one found.
   *
   * The one construct this adds over the old logic is "mps" BranchData: a classic-ladder
   * "multiple output points" node, where several independent action rows (each its own
   * CoilData/fb-action, each possibly with its own extra leading contacts) all share whatever
   * condition led into the mps node. Each row is walked as its own nested CollectActions call
   * seeded with the current pathTerms, so nested mps (rung continues into a further multi-output
   * block after a compare) works the same way at any depth.
   */
  static void CollectActions(List<ClrObject> elems, List<string> pathTerms, List<string> results, string comment){
    var localTerms = new List<string>(pathTerms);
    foreach (var e in elems) {
      var st = ShortTypeName(e);
      if (st == "SpaceData" || st == "LinkData") continue;
      if (st == "CoilData") {
        string coilVar = RStr(e, "variable");
        if (coilVar.Length > 0) {
          _coilActionCount++;
          results.Add(BuildActionJson(comment, coilVar, RStr(e,"storage"), null, null, localTerms));
        }
        continue;
      }
      if (st == "BranchData") {
        string btype = RStr(e, "type");
        if (btype == "mps") {
          foreach (var row in GetGridRows(e)) CollectActions(row, localTerms, results, comment);
          continue;
        }
        if (btype == "fb") {
          ClrObject inMacro, outMacro, block;
          GetFbParts(e, out inMacro, out outMacro, out block);
          if (block.IsNull) { _unknownCount++; localTerms.Add("{\"t\":\"unknown\",\"desc\":\"fb branch with no Block found\"}"); continue; }
          string typeName = RStr(block, "typeName");
          int apiNum = RInt(block, "apiNum");
          if (IsMovBlock(typeName, apiNum) && !outMacro.IsNull && !inMacro.IsNull) {
            var outVars = ReadList(RObj(outMacro, "outVarList"));
            var inVarsMov = ReadList(RObj(inMacro, "inVarList"));
            if (outVars.Count > 0 && inVarsMov.Count > 0) {
              string destVar = RStr(outVars[0], "expression");
              string srcExpr = RStr(inVarsMov[0], "expression");
              _movActionCount++;
              results.Add(BuildActionJson(comment, destVar, null, srcExpr, null, localTerms));
              continue;
            }
          } else if ((IsIncBlock(typeName, apiNum) || IsDecBlock(typeName, apiNum)) && !inMacro.IsNull) {
            // INC/DEC self-modify their single operand (OutVariablesMacro is present but empty):
            // the operand named in InVariablesMacro is both the read and the write target.
            var inVarsIncDec = ReadList(RObj(inMacro, "inVarList"));
            if (inVarsIncDec.Count > 0) {
              string targetVar = RStr(inVarsIncDec[0], "expression");
              _incActionCount++;
              results.Add(BuildActionJson(comment, targetVar, null, null, IsDecBlock(typeName, apiNum) ? -1 : 1, localTerms));
              continue;
            }
          }
          // Not a recognized action -- fall back to the existing condition-term resolver
          // (compare ops, or an "unknown" marker for anything else).
          var term = ResolveFbBranch(e);
          if (term != null) localTerms.Add(term);
          continue;
        }
        // "normal" OR-branch: resolves to a boolean condition term (existing logic).
        var orTerm = ResolveOrBranch(e);
        if (orTerm != null) localTerms.Add(orTerm);
        continue;
      }
      // ContactData (and anything else ResolveTerm already understands as a plain condition).
      var t = ResolveTerm(e);
      if (t != null) localTerms.Add(t);
    }
  }

  /** Emits every action (coil and/or MOV/INC/DEC) found in one NetWorkData, each as its own
      JSON object sharing the network's comment, gated by the AND-chain of conditions that leads
      to it. Returns an empty list if the network carries no recognizable action. */
  static List<string> EmitNetworkActions(ClrObject netObj){
    var elems = ReadList(RObj(netObj, "iList"));
    string comment = RStr(netObj, "comment");
    var results = new List<string>();
    CollectActions(elems, new List<string>(), results, comment);
    return results;
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
        int networkCount = PouConvertData(obj).Count;
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
          string comment = RStr(obj, "comment");
          if (onlyCommented && IsPlaceholderComment(comment)) continue;
          var actionJsons = EmitNetworkActions(obj);
          if (actionJsons.Count == 0) continue;
          netCount++;
          foreach (var json in actionJsons) {
            if (emitted >= maxNetworks) break;
            coilCount++;
            if (emitted > 0) nets.Append(",");
            nets.Append(json);
            emitted++;
          }
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

  /**
   * Reliable per-POU network source: POU.codeBody.codeWorkSheet.programmingDataLoader.ConvertDataList
   * is a List<IspConvertData> whose elements are the SAME IspProject.NetWorkData objects that Run()'s
   * whole-heap scan finds -- but scoped to exactly this POU, and populated even when the POU's tab is
   * not open in the UI (unlike codeBody.codeWorkSheet.graphicCanvasData, which is UI/rendering state
   * and empty on an idle document). This is what makes true per-POU extraction possible.
   */
  static List<ClrObject> PouConvertData(ClrObject pou){
    var codeBody = RObj(pou, "codeBody");
    var ws = RObj(codeBody, "codeWorkSheet");
    var loader = RObj(ws, "programmingDataLoader");
    return ReadList(RObj(loader, "ConvertDataList"));
  }

  /** Real per-POU extraction (see PouConvertData), same JSON shape as Run(). */
  public static string RunPou(int pid, string pouName, int maxNetworks, bool onlyCommented){
    var vars = new SortedSet<string>();
    var nets = new StringBuilder();
    int netCount=0, emitted=0, coilCount=0;
    _contactCount = 0; _compareCount = 0; _unknownCount = 0;

    using (var dt = DataTarget.AttachToProcess(pid, false)) {
      _heap = dt.ClrVersions[0].CreateRuntime().Heap;
      var pou = FindPou(pouName);
      if (pou.IsNull) return "{\"ok\":false,\"error\":\"POU not found in live process: " + J(pouName) + "\"}";

      foreach (var netObj in PouConvertData(pou)) {
        if (ShortTypeName(netObj) != "NetWorkData") continue;
        if (emitted >= maxNetworks) continue;
        string comment = RStr(netObj, "comment");
        if (onlyCommented && IsPlaceholderComment(comment)) continue;
        var actionJsons = EmitNetworkActions(netObj);
        if (actionJsons.Count == 0) continue;
        var elems = ReadList(RObj(netObj, "iList"));
        foreach (var e in elems) CollectVars(e, vars);
        netCount++;
        foreach (var json in actionJsons) {
          if (emitted >= maxNetworks) break;
          coilCount++;
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
    outSb.Append(",\"pouName\":\""+J(pouName)+"\"");
    outSb.Append(",\"stats\":{\"networksWithLogic\":"+netCount+",\"coils\":"+coilCount+",\"contacts\":"+_contactCount+
                 ",\"compares\":"+_compareCount+",\"unresolved\":"+_unknownCount+",\"uniqueVariables\":"+vars.Count+"}");
    outSb.Append(",\"networksEmitted\":"+emitted);
    outSb.Append(",\"variables\":["+vs+"]");
    outSb.Append(",\"networks\":["+nets+"]}");
    return outSb.ToString();
  }

  /** Same as RunPou, but for many POUs in a single attach AND a single heap pass (FindPou alone is a full heap
      enumeration, so calling it once per POU multiplies scan cost by POU count -- this instead walks the heap
      once and matches every requested name as it goes). */
  public static string RunPous(int pid, string[] pouNames, int maxNetworks, bool onlyCommented){
    var outSb = new StringBuilder();
    outSb.Append("{\"ok\":true,\"pid\":"+pid+",\"pous\":{");
    using (var dt = DataTarget.AttachToProcess(pid, false)) {
      _heap = dt.ClrVersions[0].CreateRuntime().Heap;

      var wanted = new HashSet<string>(pouNames);
      var found = new Dictionary<string, ClrObject>();
      foreach (var obj in _heap.EnumerateObjects()) {
        var t = obj.Type; if (t == null) continue;
        var tn = t.Name; if (tn == null || !tn.EndsWith(".POU")) continue;
        var nm = RStr(obj, "name");
        if (nm.Length == 0 || found.ContainsKey(nm) || !wanted.Contains(nm)) continue;
        found[nm] = obj;
        if (found.Count == wanted.Count) break;
      }

      bool firstPou = true;
      foreach (var pouName in pouNames) {
        var vars = new SortedSet<string>();
        var nets = new StringBuilder();
        int netCount=0, emitted=0, coilCount=0;
        _contactCount = 0; _compareCount = 0; _unknownCount = 0;

        if (!firstPou) outSb.Append(",");
        firstPou = false;
        ClrObject pou;
        if (!found.TryGetValue(pouName, out pou)) {
          outSb.Append("\""+J(pouName)+"\":{\"ok\":false,\"error\":\"not found\"}");
          continue;
        }

        foreach (var netObj in PouConvertData(pou)) {
          if (ShortTypeName(netObj) != "NetWorkData") continue;
          if (emitted >= maxNetworks) continue;
          string comment = RStr(netObj, "comment");
          if (onlyCommented && IsPlaceholderComment(comment)) continue;
          var actionJsons = EmitNetworkActions(netObj);
          if (actionJsons.Count == 0) continue;
          var elems = ReadList(RObj(netObj, "iList"));
          foreach (var e in elems) CollectVars(e, vars);
          netCount++;
          foreach (var json in actionJsons) {
            if (emitted >= maxNetworks) break;
            coilCount++;
            if (emitted > 0) nets.Append(",");
            nets.Append(json);
            emitted++;
          }
        }

        var vs = new StringBuilder(); bool vf=true;
        foreach(var v in vars){ if(!vf)vs.Append(","); vf=false; vs.Append("\""+J(v)+"\""); }

        outSb.Append("\""+J(pouName)+"\":{\"ok\":true");
        outSb.Append(",\"stats\":{\"networksWithLogic\":"+netCount+",\"coils\":"+coilCount+",\"contacts\":"+_contactCount+
                     ",\"compares\":"+_compareCount+",\"unresolved\":"+_unknownCount+",\"uniqueVariables\":"+vars.Count+"}");
        outSb.Append(",\"networksEmitted\":"+emitted);
        outSb.Append(",\"variables\":["+vs+"]");
        outSb.Append(",\"networks\":["+nets+"]}");
      }
    }
    outSb.Append("}}");
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
    } else if (st == "OutVariablesMacro") {
      foreach (var ov in ReadList(RObj(e, "outVarList"))) {
        var expr = RStr(ov, "expression");
        if (expr.Length > 0 && !char.IsDigit(expr[0]) && expr[0] != '-') vars.Add(expr);
      }
    }
  }
}
