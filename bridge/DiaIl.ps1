# usage: il.ps1 Asm.dll TypeFullName MethodName   (MethodName '*' = all methods, names only)
param([string]$Asm,[string]$Type,[string]$Method='*')
$InstallDir='C:\Program Files (x86)\Delta Industrial Automation\DIAStudio\DIADesigner 1.14'
Set-Location $InstallDir
$resolver=[System.ResolveEventHandler]{ param($s,$e) $n=$e.Name.Split(',')[0]; foreach($sub in @('','lib\','PluginView\')){ $c=Join-Path $InstallDir ($sub+$n+'.dll'); if(Test-Path $c){ try{return [Reflection.Assembly]::LoadFrom($c)}catch{return $null}}}; return $null }
[AppDomain]::CurrentDomain.add_AssemblyResolve($resolver)
Add-Type -TypeDefinition @"
using System; using System.Reflection; using System.Reflection.Emit; using System.Text; using System.Collections.Generic; using System.Linq;
public static class IL {
 static Dictionary<short,OpCode> ops=new Dictionary<short,OpCode>();
 static IL(){ foreach(var f in typeof(OpCodes).GetFields(BindingFlags.Public|BindingFlags.Static)){ var o=(OpCode)f.GetValue(null); ops[o.Value]=o; } }
 static string Res(Module mod,int tok,Type[] ta,Type[] ma){
  try{ var r=mod.ResolveMember(tok,ta,ma); var mb=r as MethodBase; string dt=r.DeclaringType!=null?r.DeclaringType.Name+"::":"";
   if(mb!=null) return dt+r.Name+"("+string.Join(",",mb.GetParameters().Select(p=>p.ParameterType.Name))+")";
   return dt+r.Name; }catch{ try{ return mod.ResolveType(tok,ta,ma).FullName; }catch{ return "tok:"+tok.ToString("x"); } } }
 public static string Dump(MethodBase m){
  var sb=new StringBuilder(); sb.AppendLine("=== "+m.DeclaringType.Name+"::"+m.Name+"("+string.Join(", ",m.GetParameters().Select(p=>p.ParameterType.Name+" "+p.Name))+")");
  var body=m.GetMethodBody(); if(body==null) return sb.ToString(); var il=body.GetILAsByteArray(); var mod=m.Module;
  Type[] ta=null; if(m.DeclaringType.IsGenericType) ta=m.DeclaringType.GetGenericArguments(); Type[] ma=null; if(m.IsGenericMethod) ma=m.GetGenericArguments();
  int i=0;
  try{ while(i<il.Length){ int start=i; short code=il[i++]; if(code==0xFE){ code=(short)(0xFE00|il[i++]); }
   OpCode o; if(!ops.TryGetValue(code,out o)){ sb.AppendLine("IL_"+start.ToString("x4")+": ??"); continue; }
   string arg="";
   switch(o.OperandType){
    case OperandType.InlineNone: break;
    case OperandType.ShortInlineBrTarget: { int v=(sbyte)il[i]; i++; arg="IL_"+(i+v).ToString("x4"); break; }
    case OperandType.ShortInlineI: case OperandType.ShortInlineVar: arg=il[i].ToString(); i++; break;
    case OperandType.InlineVar: arg=BitConverter.ToInt16(il,i).ToString(); i+=2; break;
    case OperandType.InlineBrTarget: { int v=BitConverter.ToInt32(il,i); i+=4; arg="IL_"+(i+v).ToString("x4"); break; }
    case OperandType.InlineI: arg=BitConverter.ToInt32(il,i).ToString(); i+=4; break;
    case OperandType.InlineI8: arg=BitConverter.ToInt64(il,i).ToString(); i+=8; break;
    case OperandType.ShortInlineR: arg=BitConverter.ToSingle(il,i).ToString(); i+=4; break;
    case OperandType.InlineR: arg=BitConverter.ToDouble(il,i).ToString(); i+=8; break;
    case OperandType.InlineString: { int t=BitConverter.ToInt32(il,i); i+=4; try{arg="\""+mod.ResolveString(t)+"\"";}catch{arg="str?"+t.ToString("x");} break; }
    case OperandType.InlineSwitch: { int n=BitConverter.ToInt32(il,i); i+=4; var ts=new List<string>(); int baseOff=i+4*n; for(int k=0;k<n;k++){ ts.Add("IL_"+(baseOff+BitConverter.ToInt32(il,i+4*k)).ToString("x4")); } i+=4*n; arg="("+string.Join(",",ts)+")"; break; }
    default: { int t=BitConverter.ToInt32(il,i); i+=4; arg=Res(mod,t,ta,ma); break; }
   }
   sb.AppendLine("IL_"+start.ToString("x4")+": "+o.Name+" "+arg);
  } }catch(Exception ex){ sb.AppendLine("ERR at "+i+": "+ex.Message); }
  return sb.ToString(); }
 public static string Run(Assembly a,string type,string method){
  Type[] ts; try{ts=a.GetTypes();}catch(ReflectionTypeLoadException e){ts=Array.FindAll(e.Types,x=>x!=null);}
  var t=ts.FirstOrDefault(x=>x.FullName==type)??ts.FirstOrDefault(x=>x.Name==type); if(t==null) return "type not found";
  var bf=BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Static|BindingFlags.Instance|BindingFlags.DeclaredOnly;
  var ms=new List<MethodBase>(); ms.AddRange(t.GetMethods(bf)); ms.AddRange(t.GetConstructors(bf));
  var sb=new StringBuilder();
  foreach(var m in ms){ if(method=="*"){ sb.AppendLine(m.Name+"("+string.Join(",",m.GetParameters().Select(p=>p.ParameterType.Name))+")"); } else if(m.Name==method){ try{ sb.Append(Dump(m)); }catch(Exception ex){ sb.AppendLine("DUMP-ERR "+ex.Message); } } }
  return sb.ToString(); }
}
"@
$a=[Reflection.Assembly]::LoadFrom((Join-Path $InstallDir $Asm))
[IL]::Run($a,$Type,$Method)
