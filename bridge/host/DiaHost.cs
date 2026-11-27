// DiaHost - runs the real DIADesigner 1.14 application in-process (no UI interaction) and
// executes one request against the opened project: inspect / import / compile / save.
//
// Build (x86, .NET Framework 4):  csc -platform:x86 -out:DiaHost.exe DiaHost.cs  (done by src/dia14/host.ts)
// The exe MUST live in a directory that contains DIADesigner's files (see host.ts: copy + junctions),
// because the application resolves Resource\ and Programming\ relative to its own directory.
//
// Environment: DIAHOST_REQUEST = path of request JSON, DIAHOST_OUT = path of result JSON.
// Args: [project.diade] - passed through to the app (the app then opens it like a double click).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Media;
using System.Windows.Controls;
using System.Xml.Linq;

public static class DiaHost
{
    public static string Dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    static string RequestPath, OutPath;
    static Application App;
    static object Shell, Device;
    static readonly List<string> Log = new List<string>();

    [STAThread]
    public static int Main(string[] args)
    {
        RequestPath = Environment.GetEnvironmentVariable("DIAHOST_REQUEST");
        OutPath = Environment.GetEnvironmentVariable("DIAHOST_OUT");
        Directory.SetCurrentDirectory(Dir);
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string n = e.Name.Split(',')[0];
            foreach (var ext in new[] { ".dll", ".exe" })
            {
                var c = Path.Combine(Dir, n + ext);
                if (File.Exists(c)) { try { return Assembly.LoadFrom(c); } catch { } }
            }
            return null;
        };
        // The app locates resources through Directory.GetCurrentDirectory(); keep it pinned.
        new Thread(() => { while (true) { try { if (Directory.GetCurrentDirectory() != Dir) Directory.SetCurrentDirectory(Dir); } catch { } Thread.Sleep(5); } }) { IsBackground = true }.Start();
        new Thread(Worker) { IsBackground = true, Name = "diahost-worker" }.Start();
        var exe = Assembly.LoadFrom(Path.Combine(Dir, "DIADesigner.exe"));
        // DIADesigner reads its own assembly as the entry assembly.
        var mgr = AppDomain.CurrentDomain.DomainManager ?? new AppDomainManager();
        typeof(AppDomainManager).GetField("m_entryAssembly", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(mgr, exe);
        typeof(AppDomain).GetField("_domainManager", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(AppDomain.CurrentDomain, mgr);
        exe.GetType("DeltaIA.DIAStudio.DIADesigner.App").GetMethod("Main", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
        return 0;
    }

    // ------------------------------------------------------------------ helpers
    static void Note(string s) { lock (Log) Log.Add(s); }
    static void UI(Action a)
    {
        Exception ex = null;
        App.Dispatcher.Invoke(new Action(() => { try { a(); } catch (Exception e) { ex = e; } }));
        if (ex != null) throw new Exception("UI action failed: " + Flat(ex), ex);
    }
    static T UI<T>(Func<T> f) { T r = default(T); UI(() => { r = f(); }); return r; }
    static string Flat(Exception e) { var sb = new StringBuilder(); for (; e != null; e = e.InnerException) sb.Append(e.GetType().Name + ": " + e.Message + " | "); return sb.ToString(); }
    static Type Find(string name)
    {
        foreach (var a in AppDomain.CurrentDomain.GetAssemblies()) { Type t = null; try { t = a.GetType(name); } catch { } if (t != null) return t; }
        return null;
    }
    static object Get(object o, string prop)
    {
        for (var c = o.GetType(); c != null; c = c.BaseType)
        {
            var p = c.GetProperty(prop, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            if (p != null) return p.GetValue(o, null);
            var f = c.GetField(prop, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            if (f != null) return f.GetValue(o);
        }
        throw new Exception("no member " + prop + " on " + o.GetType().FullName);
    }
    static object Call(object o, string method, params object[] args)
    {
        for (var c = o.GetType(); c != null; c = c.BaseType)
            foreach (var m in c.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                if (m.Name != method) continue;
                var ps = m.GetParameters(); if (ps.Length != args.Length) continue;
                bool ok = true;
                for (int i = 0; i < ps.Length; i++) if (args[i] != null && !ps[i].ParameterType.IsAssignableFrom(args[i].GetType())) { ok = false; break; }
                if (!ok) continue;
                try { return m.Invoke(o, args); } catch (TargetInvocationException e) { throw new Exception(method + " failed: " + Flat(e.InnerException), e.InnerException); }
            }
        throw new Exception("no method " + method + " on " + o.GetType().FullName);
    }
    static void Texts(DependencyObject d, List<string> acc)
    {
        if (d == null) return;
        var tb = d as TextBlock; if (tb != null && !string.IsNullOrEmpty(tb.Text)) acc.Add(tb.Text);
        for (int i = 0, n = VisualTreeHelper.GetChildrenCount(d); i < n; i++) Texts(VisualTreeHelper.GetChild(d, i), acc);
    }
    static string MessageBoxes()
    {
        return UI(() =>
        {
            var sb = new StringBuilder();
            foreach (Window w in App.Windows) if (w.GetType().Name == "MessageBoxView") { var acc = new List<string>(); Texts(w, acc); sb.Append(string.Join(" | ", acc.ToArray()) + "; "); }
            return sb.ToString();
        });
    }
    static object Project() { return Get(Get(Device, "ProgrammingProjectFunction"), "ProgrammingProject"); }

    static bool WaitDevice(int sec, Dictionary<string, object> result)
    {
        for (int k = 0; k < sec * 2 && Device == null; k++)
        {
            UI(() =>
            {
                foreach (Window w in App.Windows)
                    if (w.GetType().Name == "MainWindowView" && w.DataContext != null) { try { Shell = Get(w.DataContext, "Shell"); } catch { } }
                if (Shell != null)
                {
                    var devs = Get(Shell, "ProjectDevices") as IEnumerable;
                    if (devs != null) foreach (var d in devs) if (d.GetType().FullName.EndsWith("PLC.AS")) Device = d;
                }
            });
            if (Device == null)
            {
                var mb = MessageBoxes();
                if (mb != "") { result["blockedByDialog"] = mb; return false; }
                Thread.Sleep(500);
            }
        }
        return Device != null;
    }

    // ------------------------------------------------------------------- worker
    static void Worker()
    {
        var result = new Dictionary<string, object>();
        try
        {
            var req = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Deserialize<Dictionary<string, object>>(File.ReadAllText(RequestPath));
            for (int i = 0; i < 600 && Application.Current == null; i++) Thread.Sleep(200);
            App = Application.Current;
            if (App == null) throw new Exception("DIADesigner application did not start");
            result["ok"] = false;
            if (!WaitDevice(Convert.ToInt32(Get(req, "openTimeoutSec", 240)), result)) { result["error"] = "No AS device opened (see blockedByDialog / log)"; }
            else
            {
                Thread.Sleep(1500);
                Run(req, result);
            }
        }
        catch (Exception ex) { result["ok"] = false; result["error"] = Flat(ex); result["stack"] = ex.ToString(); }
        lock (Log) result["log"] = Log.ToArray();
        File.WriteAllText(OutPath, new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(result), new UTF8Encoding(false));
        Thread.Sleep(300);
        System.Diagnostics.Process.GetCurrentProcess().Kill(); // skip the app's crashing finalizers
    }
    static object Get(Dictionary<string, object> d, string k, object def) { object v; return d.TryGetValue(k, out v) && v != null ? v : def; }
    static bool B(Dictionary<string, object> d, string k, bool def) { object v; return d.TryGetValue(k, out v) && v is bool ? (bool)v : def; }
    static string S(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as string : null; }

    static void Run(Dictionary<string, object> req, Dictionary<string, object> result)
    {
        string action = S(req, "action") ?? "inspect";
        var errors = new List<Dictionary<string, object>>();
        if (S(req, "exportPath") != null) result["import"] = Import(S(req, "exportPath"), B(req, "clean", false));
        if (action == "compile" || B(req, "compile", false) || action == "import" && B(req, "compile", true))
            result["compile"] = Compile();
        result["project"] = Inspect();
        if (S(req, "dumpXml") != null) UI(() => File.WriteAllText(S(req, "dumpXml"), ((XElement)Call(Project(), "GetXml")).ToString(), new UTF8Encoding(false)));
        if (B(req, "save", false))
        {
            bool saved = UI(() =>
            {
                var dpT = Find("DeltaIA.DIAStudio.DIADesigner.Modules.Solution.DIADesignerProject");
                var dp = dpT.GetProperty("DIAProject", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).GetValue(null, null);
                return (bool)Call(dp, "Save");
            });
            result["saved"] = saved;
        }
        var mb = MessageBoxes(); if (mb != "") result["dialogs"] = mb;
        result["ok"] = true;
    }

    // ------------------------------------------------------------------ inspect
    static Dictionary<string, object> Inspect()
    {
        return UI(() =>
        {
            var r = new Dictionary<string, object>();
            var proj = Project();
            var xml = (XElement)Call(proj, "GetXml");
            r["device"] = Get(Get(Device, "DeviceInfoObject"), "ProductType");
            r["name"] = Get(Get(Device, "DeviceInfoObject"), "Name");
            r["dataTypes"] = xml.Element("types").Element("dataTypes").Elements("dataType").Select(e => (string)e.Attribute("name")).ToArray();
            r["pous"] = xml.Element("types").Element("pous").Elements("pou").Select(e => new Dictionary<string, object> {
                { "name", (string)e.Attribute("name") }, { "type", (string)e.Attribute("pouType") },
                { "language", e.Element("body") != null && e.Element("body").Elements().Any() ? e.Element("body").Elements().First().Name.LocalName : "" } }).ToArray();
            var res = xml.Element("instances").Element("configurations").Element("configuration").Element("resource");
            r["globalTables"] = res.Elements("globalVars").Select(e => new Dictionary<string, object> { { "name", (string)e.Attribute("name") }, { "type", (string)e.Attribute("type") }, { "variables", e.Elements("variable").Count() } }).ToArray();
            r["tasks"] = res.Elements("task").Where(t => t.Elements("pouInstance").Any()).Select(t => new Dictionary<string, object> { { "name", (string)t.Attribute("name") }, { "pouInstances", t.Elements("pouInstance").Select(p => (string)p.Attribute("name")).ToArray() } }).ToArray();
            return r;
        });
    }

    // ------------------------------------------------------------------- import
    static Dictionary<string, object> Import(string exportPath, bool clean)
    {
        return UI(() =>
        {
            var r = new Dictionary<string, object>();
            var proj = Project();
            var doc = new XDocument(new XElement((XElement)Call(proj, "GetXml")));
            var exp = XDocument.Load(exportPath);
            var types = doc.Root.Element("types");
            var dts = types.Element("dataTypes"); var pous = types.Element("pous");
            var res = doc.Root.Element("instances").Element("configurations").Element("configuration").Element("resource");
            if (clean)
            {
                dts.RemoveNodes(); pous.RemoveNodes();
                foreach (var t in res.Elements("task")) t.Elements("pouInstance").Remove();
                foreach (var g in res.Elements("globalVars").Where(g => (string)g.Attribute("type") == "Default").ToList()) { if ((string)g.Attribute("name") == "Default_Tag_Table") g.RemoveNodes(); else g.Remove(); }
            }
            int nd = 0, np = 0, nv = 0;
            foreach (var dt in exp.Descendants("dataTypes").Elements("dataType")) { string n = (string)dt.Attribute("name"); dts.Elements("dataType").Where(e => (string)e.Attribute("name") == n).Remove(); dts.Add(new XElement(dt)); nd++; }
            foreach (var p in exp.Descendants("pous").Elements("pou")) { string n = (string)p.Attribute("name"); pous.Elements("pou").Where(e => (string)e.Attribute("name") == n).Remove(); pous.Add(new XElement(p)); np++; }
            var expRes = exp.Descendants("resource").FirstOrDefault(x => x.Elements("globalVars").Any() || x.Elements("task").Any());
            if (expRes != null)
            {
                foreach (var eg in expRes.Elements("globalVars"))
                {
                    string gn = (string)eg.Attribute("name");
                    var ex = res.Elements("globalVars").FirstOrDefault(g => (string)g.Attribute("name") == gn);
                    if (ex == null)
                    {
                        ex = new XElement("globalVars", new XAttribute("name", gn), new XAttribute("type", (string)eg.Attribute("type") ?? "Default"));
                        var last = res.Elements("globalVars").First(); last.AddBeforeSelf(ex);
                    }
                    foreach (var v in eg.Elements("variable")) { string vn = (string)v.Attribute("name"); ex.Elements("variable").Where(e => (string)e.Attribute("name") == vn).Remove(); ex.Add(new XElement(v)); nv++; }
                }
                foreach (var et in expRes.Elements("task"))
                {
                    string tn = (string)et.Attribute("name"), tp = (string)et.Attribute("priority");
                    // Task names are localised by DIADesigner; the priority is stable.
                    var t = res.Elements("task").FirstOrDefault(x => tp != null ? (string)x.Attribute("priority") == tp : (string)x.Attribute("name") == tn);
                    if (t == null) throw new Exception("task not found in project: " + (tp ?? tn));
                    t.Elements("pouInstance").Remove();
                    var first = t.FirstNode;
                    foreach (var pi in et.Elements("pouInstance")) { if (first != null) first.AddBeforeSelf(new XElement(pi)); else t.Add(new XElement(pi)); }
                }
            }
            Call(Device, "ParseProgrammingProject", doc.Root, true);
            r["dataTypes"] = nd; r["pous"] = np; r["variables"] = nv;
            return r;
        });
    }

    // ------------------------------------------------------------------ compile
    static Dictionary<string, object> Compile()
    {
        object elm = null, mgr = null, isp = null;
        UI(() =>
        {
            var ufm = Find("DeltaIA.DIAStudio.UIFramework.UIFrameworkManager");
            elm = ufm.GetProperty("ErrorListManager", BindingFlags.Public | BindingFlags.Static).GetValue(null, null);
            Call(elm, "ClearItems");
            isp = Get(Device, "IspCompilationFunction");
            mgr = Get(isp, "IspCompilationManager");
            Call(isp, "Compile");
        });
        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (int i = 0; i < 1200; i++)
        {
            Thread.Sleep(500);
            bool busy = UI(() => (bool)Get(mgr, "IsCompiling"));
            if (!busy && i > 2) break;
        }
        return UI(() =>
        {
            var r = new Dictionary<string, object>();
            var items = new List<Dictionary<string, object>>();
            int err = 0, warn = 0, info = 0;
            foreach (var e in (IEnumerable)Get(elm, "Items"))
            {
                var d = new Dictionary<string, object>();
                string type = Convert.ToString(Get(e, "ItemType"));
                d["type"] = type; d["program"] = Convert.ToString(Get(e, "Program")); d["position"] = Convert.ToString(Get(e, "Position"));
                d["errorCode"] = Convert.ToString(Get(e, "ErrorCode")); d["description"] = Convert.ToString(Get(e, "Description"));
                try { d["line"] = Get(e, "Line"); d["column"] = Get(e, "Column"); } catch { }
                if (type == "Error") err++; else if (type == "Warning") warn++; else info++;
                items.Add(d);
            }
            var res = Get(mgr, "compilationResult");
            r["errorCount"] = err; r["warningCount"] = warn; r["messages"] = items.ToArray();
            r["exeSize"] = Get(res, "ExectuionCodeSize"); r["seconds"] = Math.Round(sw.Elapsed.TotalSeconds, 1);
            return r;
        });
    }
}
