using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows;

// Hosts the real DIADesigner application in-process and runs an eval script inside it.
public static class DiaHost
{
    public static string InstallDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    public static string ScriptPath;
    public static string OutPath;

    [STAThread]
    public static int Main(string[] args)
    {
        // env: DIAHOST_SCRIPT, DIAHOST_OUT ; args: [project.diade]
        ScriptPath = Environment.GetEnvironmentVariable("DIAHOST_SCRIPT"); OutPath = Environment.GetEnvironmentVariable("DIAHOST_OUT");
        Directory.SetCurrentDirectory(InstallDir);
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string n = e.Name.Split(',')[0];
            foreach (var sub in new[] { "", "lib\\", "PluginView\\" })
            {
                var c = Path.Combine(InstallDir, sub + n + ".dll");
                if (File.Exists(c)) { try { return Assembly.LoadFrom(c); } catch { } }
                c = Path.Combine(InstallDir, sub + n + ".exe");
                if (File.Exists(c)) { try { return Assembly.LoadFrom(c); } catch { } }
            }
            return null;
        };
        var cwdT = new Thread(() => { while (true) { try { if (Directory.GetCurrentDirectory() != InstallDir) Directory.SetCurrentDirectory(InstallDir); } catch { } Thread.Sleep(5); } }) { IsBackground = true };
        cwdT.Start();
        File.WriteAllText(OutPath, "");
        var t = new Thread(Worker) { IsBackground = true };
        t.Start();
        return Run();
    }

    static int Run()
    {
        var exe = Assembly.LoadFrom(Path.Combine(InstallDir, "DIADesigner.exe"));
        var mgr = AppDomain.CurrentDomain.DomainManager ?? new AppDomainManager();
        typeof(AppDomainManager).GetField("m_entryAssembly", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(mgr, exe);
        typeof(AppDomain).GetField("_domainManager", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(AppDomain.CurrentDomain, mgr);
        Log("entry=" + Assembly.GetEntryAssembly());
        var app = exe.GetType("DeltaIA.DIAStudio.DIADesigner.App");
        app.GetMethod("Main", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
        return 0;
    }

    public static void Log(string s)
    {
        lock (typeof(DiaHost)) File.AppendAllText(OutPath, s + Environment.NewLine, Encoding.UTF8);
    }

    static void Worker()
    {
        try
        {
            Application a = null;
            for (int i = 0; i < 600 && a == null; i++) { Thread.Sleep(200); a = Application.Current; }
            if (a == null) { Log("NOAPP"); Environment.Exit(2); }
            Log("APP up");
            // wait for main window
            for (int i = 0; i < 600; i++)
            {
                Thread.Sleep(500);
                bool ready = false;
                a.Dispatcher.Invoke(new Action(() => { ready = a.MainWindow != null && a.MainWindow.IsLoaded; }));
                if (ready) break;
            }
            Log("MAINWINDOW ready");

            Thread.Sleep(1500);
            var src = File.ReadAllText(ScriptPath);
            var prov = new Microsoft.CSharp.CSharpCodeProvider();
            var cp = new System.CodeDom.Compiler.CompilerParameters { GenerateInMemory = true };
            cp.ReferencedAssemblies.Add("System.dll"); cp.ReferencedAssemblies.Add("System.Core.dll");
            cp.ReferencedAssemblies.Add("System.Xml.dll"); cp.ReferencedAssemblies.Add("System.Xml.Linq.dll");
            cp.ReferencedAssemblies.Add(typeof(System.Windows.DependencyObject).Assembly.Location); cp.ReferencedAssemblies.Add(typeof(System.Windows.Application).Assembly.Location);
            cp.ReferencedAssemblies.Add(typeof(System.Windows.UIElement).Assembly.Location); cp.ReferencedAssemblies.Add(typeof(System.Xaml.XamlReader).Assembly.Location);
            cp.ReferencedAssemblies.Add(typeof(DiaHost).Assembly.Location);
            foreach (var f in Directory.GetFiles(InstallDir, "*.dll")) { }
            var res = prov.CompileAssemblyFromSource(cp, src);
            if (res.Errors.HasErrors) { foreach (System.CodeDom.Compiler.CompilerError e in res.Errors) Log("CSERR " + e); Environment.Exit(3); }
            var m = res.CompiledAssembly.GetType("Script").GetMethod("Run");
            m.Invoke(null, new object[] { a });
        }
        catch (Exception ex) { Log("WORKER-EXC " + ex); }
        Log("DONE");
        try { Application.Current.Dispatcher.Invoke(new Action(() => { Application.Current.Shutdown(); })); } catch { }
        Thread.Sleep(3000);
        Environment.Exit(0);
    }
}
