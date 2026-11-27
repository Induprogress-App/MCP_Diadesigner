public static class Script {
  static object elm, mgr, isp;
  static string DoCompile(string label) {
    P.UI(() => {
      var ufm = P.Find("DeltaIA.DIAStudio.UIFramework.UIFrameworkManager");
      elm = ufm.GetProperty("ErrorListManager", BindingFlags.Public|BindingFlags.Static).GetValue(null, null);
      P.Call(elm, "ClearItems");
      isp = P.Get(P.Device, "IspCompilationFunction");
      mgr = P.Get(isp, "IspCompilationManager");
      P.Call(isp, "Compile");
    });
    for (int i = 0; i < 120; i++) {
      System.Threading.Thread.Sleep(500);
      bool busy = P.UI(() => (bool)P.Get(mgr, "IsCompiling"));
      if (!busy && i > 2) break;
    }
    return P.UI(() => {
      var res = P.Get(mgr, "compilationResult");
      var sb = new StringBuilder();
      foreach (var e in (IEnumerable)P.Get(elm, "Items")) sb.Append("\n  [" + P.Get(e, "ItemType") + " " + P.Get(e, "Program") + " " + P.Get(e, "Position") + " " + P.Get(e, "ErrorCode") + " " + P.Get(e, "Description") + "]");
      return label + ": exeSize=" + P.Get(res, "ExectuionCodeSize") + sb;
    });
  }
  public static void Run(Application app) {
    P.App = app;
    if (!P.WaitDevice(180)) { P.Log("no device " + P.MessageBoxes()); return; }
    var outDir = Path.GetDirectoryName(Environment.GetEnvironmentVariable("DIAHOST_OUT"));
    P.UI(() => {
      var proj = P.Project();
      var baseXml = (XElement)P.Call(proj, "GetXml");
      var doc = new XDocument(new XElement(baseXml));
      var types = doc.Root.Element("types");
      var dts = types.Element("dataTypes");
      dts.Add(XElement.Parse(@"<dataType name=""EnumMode""><baseType><enum><values><value name=""ModeOff"" value=""0"" /><value name=""ModeManual"" value=""1"" /></values></enum></baseType></dataType>"));
      dts.Add(XElement.Parse(@"<dataType name=""DutPar""><baseType><struct>
        <variable name=""A""><type><INT /></type><initialValue><simpleValue value=""150"" /></initialValue></variable>
        <variable name=""Spare""><type><array><dimension lower=""17"" upper=""99"" /><baseType><INT /></baseType></array></type></variable>
        <variable name=""Mode""><type><derived name=""EnumMode"" /></type></variable>
      </struct></baseType></dataType>"));
      foreach (var dt in dts.Elements("dataType").ToList()) {
        string nm = (string)dt.Attribute("name");
        string code = nm == "EnumMode" ? File.ReadAllText(@"E:\SynologyDrive\Amix\AMIX_LiniaDoPalet\RP120\PLC\ST\EnumMode.st") : File.ReadAllText(@"E:\SynologyDrive\Amix\AMIX_LiniaDoPalet\RP120\PLC\ST\DutRpPar.st");
        if (nm == "DutPar") code = code.Replace("DutRpPar", "DutPar");
        dt.Add(new XElement("codeSection", new XCData(code)));
      }
      var pous = types.Element("pous");
      var fb = XElement.Parse(@"<pou name=""FbX"" pouType=""functionBlock"" active=""true""><interface>
        <inputVars><variable name=""Run""><type><BOOL /></type><scope><VAR_INPUT /></scope></variable></inputVars>
        <outputVars><variable name=""Done""><type><BOOL /></type><scope><VAR_OUTPUT /></scope></variable></outputVars>
        <localVars><variable name=""Cnt""><type><INT /></type><scope><VAR /></scope></variable></localVars>
      </interface><body><ST></ST></body></pou>");
      fb.Element("body").Element("ST").Add(new XCData("IF Run THEN Cnt := Cnt + 1; END_IF;\nDone := Cnt > 5;\n"));
      pous.Add(fb);
      var prg = XElement.Parse(@"<pou name=""Main"" pouType=""program"" active=""true""><interface><localVars><variable name=""t""><type><BOOL /></type><scope><VAR /></scope></variable></localVars></interface><body><ST></ST></body></pou>");
      prg.Element("body").Element("ST").Add(new XCData("Inst(Run := G1);\nG2 := Par.A + Par.Spare[20];\nPar.Mode := ModeManual;\nt := Inst.Done;\nG1 := t;\n"));
      pous.Add(prg);
      var res = doc.Root.Element("instances").Element("configurations").Element("configuration").Element("resource");
      var gv = res.Elements("globalVars").First(x => (string)x.Attribute("type") == "Default");
      gv.Add(XElement.Parse(@"<variable name=""G1"" address=""M400""><type><BOOL /></type><scope><VAR /></scope></variable>"));
      gv.Add(XElement.Parse(@"<variable name=""G2"" address=""D400""><type><INT /></type><scope><VAR /></scope></variable>"));
      gv.Add(XElement.Parse(@"<variable name=""Par"" address=""D20000""><type><derived name=""DutPar"" /></type><scope><VAR /></scope></variable>"));
      gv.Add(XElement.Parse(@"<variable name=""Inst""><type><derived name=""FbX"" /></type><scope><VAR /></scope></variable>"));
      var t = res.Elements("task").First(x => (string)x.Attribute("priority") == "1");
      t.AddFirst(XElement.Parse(@"<pouInstance name=""Main"" typeName=""Main"" />"));
      P.Write(Path.Combine(outDir, "s17_input.xml"), doc.ToString());
      P.Call(P.Device, "ParseProgrammingProject", doc.Root, true);
      P.Write(Path.Combine(outDir, "s17_after.xml"), ((XElement)P.Call(proj, "GetXml")).ToString());
    });
    P.Log(DoCompile("compile"));
    P.UI(() => { P.Write(Path.Combine(Path.GetDirectoryName(Environment.GetEnvironmentVariable("DIAHOST_OUT")), "s17_compilexml.xml"), (string)P.Call(mgr, "GenerateCompileXml", false)); });
  }
}
