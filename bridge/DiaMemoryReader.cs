using Microsoft.Diagnostics.Runtime;
using System;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Collections.Generic;

// Reads a DIADesigner process's decrypted Ladder program straight out of its
// managed heap with ClrMD (read-only attach). DIADesigner keeps program logic
// AES-encrypted on disk, but once a project is open the objects are in memory in
// the clear. The classes we read (IspProject.*) are the ISP converter's flat
// form of every network: NetWorkData holds a comment and an iList of elements
// (ContactData / CoilData / Block, plus BranchData / LinkData / SpaceData that
// describe the grid topology).
public class DiaMemoryReader {
  static MethodInfo _rf = typeof(ClrObject).GetMethod("ReadField");
  static ClrHeap _heap;

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
  static string ReadStrArr(ClrObject o, string f){
    var a=RObj(o,f); if(a.IsNull||!a.IsArray) return "";
    var arr=a.AsArray(); var p=new List<string>();
    for(int i=0;i<arr.Length;i++){ try{ ulong ad=(ulong)arr.GetObjectValue(i); if(ad!=0){ var so=_heap.GetObject(ad); var sv=so.AsString(); if(!string.IsNullOrEmpty(sv)) p.Add(sv); } }catch{} }
    return string.Join(",",p);
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

  public static string Run(int pid, int maxNetworks, bool onlyCommented){
    var vars = new SortedSet<string>();
    var nets = new StringBuilder();
    int netCount=0, emitted=0, contacts=0, coils=0, blocks=0;

    using (var dt = DataTarget.AttachToProcess(pid, false)) {
      _heap = dt.ClrVersions[0].CreateRuntime().Heap;
      foreach (var obj in _heap.EnumerateObjects()) {
        var t=obj.Type; if(t==null) continue;
        var tn=t.Name; if(tn==null) continue;
        if(tn=="DeltaIA.DIAStudio.Programming.Project.IspProject.ContactData"){ var v=RStr(obj,"variable"); if(v.Length>0)vars.Add(v); continue; }
        if(tn=="DeltaIA.DIAStudio.Programming.Project.IspProject.CoilData"){ var v=RStr(obj,"variable"); if(v.Length>0)vars.Add(v); continue; }
        if(tn!="DeltaIA.DIAStudio.Programming.Project.IspProject.NetWorkData") continue;

        var elems = ReadList(RObj(obj,"iList"));
        // keep only the meaningful elements; Space/Link/Branch are grid glue
        var logic = new List<ClrObject>();
        bool hasBranch = false;
        foreach(var e in elems){
          var en = e.Type==null?"":e.Type.Name;
          if(en.EndsWith(".ContactData")||en.EndsWith(".CoilData")||en.EndsWith(".Block")) logic.Add(e);
          else if(en.EndsWith(".BranchData")) hasBranch = true;
        }
        if(logic.Count==0) continue;
        netCount++;
        string comment = RStr(obj,"comment");
        if(onlyCommented && (comment.Length==0 || comment=="Enter comment here…")) continue;
        if(emitted>=maxNetworks) continue;

        var es = new StringBuilder();
        bool first=true;
        foreach(var e in logic){
          var en = e.Type.Name;
          string kind, extra="";
          string v = RStr(e,"variable");
          if(en.EndsWith(".ContactData")){ kind="contact"; contacts++; extra=",\"negated\":"+(RBool(e,"negated")?"true":"false"); var edge=RStr(e,"edge"); if(edge!="none"&&edge.Length>0)extra+=",\"edge\":\""+J(edge)+"\""; }
          else if(en.EndsWith(".CoilData")){ kind="coil"; coils++; var st=RStr(e,"storage"); if(st!="none"&&st.Length>0)extra=",\"storage\":\""+J(st)+"\""; }
          else { kind="block"; blocks++; v=RStr(e,"typeName"); extra=",\"api\":"+RInt(e,"apiNum"); var iv=RStr(e,"variable"); if(iv.Length>0)extra+=",\"var\":\""+J(iv)+"\""; }
          if(!first)es.Append(",");
          first=false;
          es.Append("{\"kind\":\""+kind+"\",\"id\":"+RInt(e,"localID")+",\"name\":\""+J(v)+"\""+extra+"}");
        }
        if(emitted>0)nets.Append(",");
        nets.Append("{\"comment\":\""+J(comment)+"\",\"branch\":"+(hasBranch?"true":"false")+",\"elements\":["+es+"]}");
        emitted++;
      }
    }

    var vs = new StringBuilder(); bool vf=true;
    foreach(var v in vars){ if(!vf)vs.Append(","); vf=false; vs.Append("\""+J(v)+"\""); }

    var outSb = new StringBuilder();
    outSb.Append("{\"ok\":true,\"pid\":"+pid);
    outSb.Append(",\"stats\":{\"networksWithLogic\":"+netCount+",\"contacts\":"+contacts+",\"coils\":"+coils+",\"blocks\":"+blocks+",\"uniqueVariables\":"+vars.Count+"}");
    outSb.Append(",\"networksEmitted\":"+emitted);
    outSb.Append(",\"variables\":["+vs+"]");
    outSb.Append(",\"networks\":["+nets+"]}");
    return outSb.ToString();
  }
}
