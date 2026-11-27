using System; using System.IO; using System.Linq; using System.Reflection; using System.Text; using System.Windows; using System.Windows.Media; using System.Windows.Controls; using System.Collections; using System.Collections.Generic; using System.Xml.Linq;
public static class P {
  public static Application App;
  public static void Log(string s) { DiaHost.Log(s); }
  public static void UI(Action a) { Exception ex = null; App.Dispatcher.Invoke(new Action(() => { try { a(); } catch (Exception e) { ex = e; } })); if (ex != null) throw new Exception("UI action failed", ex); }
  public static T UI<T>(Func<T> f) { T r = default(T); UI(() => { r = f(); }); return r; }
  public static Type Find(string name) {
    foreach (var a in AppDomain.CurrentDomain.GetAssemblies()) { Type t = null; try { t = a.GetType(name); } catch {} if (t != null) return t; }
    return null; }
  public static object Get(object o, string prop) {
    if (o == null) return null;
    var t = o.GetType();
    for (var c = t; c != null; c = c.BaseType) {
      var p = c.GetProperty(prop, BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.DeclaredOnly);
      if (p != null) return p.GetValue(o, null);
      var f = c.GetField(prop, BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.DeclaredOnly);
      if (f != null) return f.GetValue(o);
    }
    throw new Exception("no member " + prop + " on " + t.FullName);
  }
  public static object Call(object o, string method, params object[] args) {
    var t = o.GetType();
    for (var c = t; c != null; c = c.BaseType) {
      foreach (var m in c.GetMethods(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.DeclaredOnly)) {
        if (m.Name != method) continue; var ps = m.GetParameters(); if (ps.Length != args.Length) continue;
        bool ok = true; for (int i = 0; i < ps.Length; i++) { if (args[i] != null && !ps[i].ParameterType.IsAssignableFrom(args[i].GetType())) { ok = false; break; } }
        if (ok) { try { return m.Invoke(o, args); } catch (TargetInvocationException e) { throw new Exception("invoke " + method + " failed", e.InnerException); } }
      }
    }
    throw new Exception("no method " + method + "/" + args.Length + " on " + t.FullName);
  }
  public static string Members(object o, string filter) {
    var sb = new StringBuilder(); var t = o.GetType(); sb.AppendLine("TYPE " + t.FullName);
    for (var c = t; c != null && c != typeof(object); c = c.BaseType) {
      foreach (var p in c.GetProperties(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static|BindingFlags.DeclaredOnly)) if (filter == null || p.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0) sb.AppendLine("  P " + c.Name + "." + p.PropertyType.Name + " " + p.Name);
      foreach (var m in c.GetMethods(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static|BindingFlags.DeclaredOnly)) if (!m.IsSpecialName && (filter == null || m.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0)) sb.AppendLine("  M " + c.Name + "." + m.ReturnType.Name + " " + m.Name + "(" + string.Join(", ", m.GetParameters().Select(x => x.ParameterType.Name + " " + x.Name).ToArray()) + ")");
    }
    return sb.ToString();
  }
  static void Texts(DependencyObject d, List<string> acc) {
    if (d == null) return;
    var tb = d as TextBlock; if (tb != null && !string.IsNullOrEmpty(tb.Text)) acc.Add(tb.Text);
    int n = VisualTreeHelper.GetChildrenCount(d);
    for (int i = 0; i < n; i++) Texts(VisualTreeHelper.GetChild(d, i), acc);
  }
  public static string MessageBoxes() {
    return UI(() => { var sb = new StringBuilder(); foreach (Window w in App.Windows) { if (w.GetType().Name == "MessageBoxView") { var acc = new List<string>(); Texts(w, acc); sb.Append("[MSGBOX " + string.Join("|", acc.ToArray()) + "]"); } } return sb.ToString(); });
  }
  public static object Shell;
  public static object Device;
  public static bool WaitDevice(int sec) {
    for (int k = 0; k < sec * 2 && Device == null; k++) {
      UI(() => {
        foreach (Window w in App.Windows) { if (w.GetType().Name == "MainWindowView" && w.DataContext != null) { Shell = Get(w.DataContext, "Shell"); } }
        if (Shell != null) { var devs = Get(Shell, "ProjectDevices") as IEnumerable; if (devs != null) foreach (var d in devs) { if (d.GetType().FullName.EndsWith("PLC.AS")) Device = d; } }
      });
      if (Device == null) { var mb = MessageBoxes(); if (mb != "") { Log("BLOCKED " + mb); return false; } System.Threading.Thread.Sleep(500); }
    }
    return Device != null;
  }
  public static object Project() { return Get(Get(Get(Device, "ProgrammingProjectFunction"), "ProgrammingProject"), "PouManager") == null ? null : Get(Get(Device, "ProgrammingProjectFunction"), "ProgrammingProject"); }
  public static void Write(string path, string s) { File.WriteAllText(path, s, new UTF8Encoding(false)); }
}
