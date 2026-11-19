// Switcher for Claude Code: the pin wrapper for Windows.
//
// Claude Code starts each chat through `claudeCode.claudeProcessWrapper` when
// that setting is on, as
//     claude-wrapper.exe <real claude> <claude's arguments...>
// The switcher turns it on only while something is pinned. This finds the
// chat's id in the arguments (--resume=<id> or --session-id=<id>, or the
// two-part forms) and the folder it starts in, and looks both up in the pins
// file named by CLAUDESWITCHER_PINS:
//     login<TAB>account<TAB>expiresAtMs<TAB>dir
//     chat<TAB>id<TAB>account        folder<TAB>folder<TAB>account
// The chat's own pin wins, then the deepest pinned folder. A pinned chat is
// started on that account's pinning login: CLAUDE_SECURESTORAGE_CONFIG_DIR
// points at <pins folder>\pinning\<account>, which moves only where Claude
// Code keeps its login (settings, skills and history stay in ~/.claude).
// The login must last at least another hour, or the chat could stop mid-way;
// otherwise, and for every chat that isn't pinned, it starts exactly as
// Claude Code asked (the active account). CLAUDE_CONFIG_DIR is never touched.
//
// While a pinned chat runs, pinning\.inuse\<pid>.json says so, so the switcher
// knows which logins are in use; it's deleted when the chat ends.
//
// The real claude reads the chat's input directly (it inherits this process's
// input), and its output is passed through byte for byte. It's placed in a
// job object that dies with this process, so stopping a chat never leaves its
// claude running.
//
// `claude-wrapper.exe --switcher-selftest` prints "claudeswitcher-wrapper ok
// <version>" and starts nothing.
//
// Build (from PowerShell, not Git Bash):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /target:exe /out:claude-wrapper.exe claude-wrapper.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class Wrapper {
  const string Version = "1.4.0";
  static readonly Regex Id = new Regex("^[A-Za-z0-9-]{8,64}$");
  // The same names the switcher allows (lib/store.js validName).
  static readonly Regex Account = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$");
  static readonly Regex Digits = new Regex("^[0-9]{1,16}$");
  // Start on the active account when the pinning login ends within this.
  const long MarginMs = 60L * 60 * 1000;

  // Quote one argument the way the C runtime reads a command line back.
  static string Quote(string s) {
    if (s.Length > 0 && s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
    var b = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in s) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
      b.Append('\\', slashes); slashes = 0; b.Append(c);
    }
    b.Append('\\', slashes * 2); b.Append('"');
    return b.ToString();
  }

  static string SessionId(string[] a) {
    string sid = null;
    for (int i = 1; i < a.Length; i++) {
      if ((a[i] == "--resume" || a[i] == "--session-id") && i + 1 < a.Length) sid = a[i + 1];
      else if (a[i].StartsWith("--resume=")) sid = a[i].Substring(9);
      else if (a[i].StartsWith("--session-id=")) sid = a[i].Substring(13);
    }
    return sid != null && Id.IsMatch(sid) ? sid : null;
  }

  static bool HasSettings(string[] a) {
    for (int i = 1; i < a.Length; i++) if (a[i] == "--settings" || a[i].StartsWith("--settings=")) return true;
    return false;
  }

  static string Norm(string p) {
    if (string.IsNullOrEmpty(p)) return "";
    return p.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant();
  }

  static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

  class Pinning { public string Name, Dir, Root; }

  // The pinning login this chat should start on, or null for the active account.
  static Pinning Find(string sid, string cwd) {
    string pins = Environment.GetEnvironmentVariable("CLAUDESWITCHER_PINS");
    if (string.IsNullOrEmpty(pins) || !File.Exists(pins)) return null;
    try {
      string root = Path.GetDirectoryName(pins);
      string[] lines = File.ReadAllLines(pins);
      string chatHit = null, folderHit = null;
      int folderLen = -1;
      string c = Norm(cwd);
      foreach (var line in lines) {
        var p = line.Split('\t');
        if (p.Length != 3) continue;
        if (p[0] == "chat" && sid != null && p[1] == sid) chatHit = p[2];
        if (p[0] == "folder") {
          string f = Norm(p[1]);
          if (f.Length > 0 && (c == f || c.StartsWith(f + "\\")) && f.Length > folderLen) { folderHit = p[2]; folderLen = f.Length; }
        }
      }
      string account = chatHit ?? folderHit;
      if (account == null || !Account.IsMatch(account)) return null;
      string expected = Path.Combine(Path.Combine(root, "pinning"), account);
      foreach (var line in lines) {
        var p = line.Split('\t');
        if (p.Length != 4 || p[0] != "login" || p[1] != account) continue;
        long expiresAt;
        if (!Digits.IsMatch(p[2]) || !long.TryParse(p[2], out expiresAt)) return null;
        if (expiresAt <= NowMs() + MarginMs) return null;
        // Only the account's own folder in the switcher's pinning folder.
        if (p[3].Length == 0 || Norm(p[3]) != Norm(expected)) return null;
        var r = new Pinning();
        r.Name = account; r.Dir = p[3]; r.Root = root;
        return r;
      }
      return null;
    } catch { return null; }
  }

  static string Json(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char ch in s) {
      if (ch == '"') b.Append("\\\"");
      else if (ch == '\\') b.Append("\\\\");
      else if (ch < 0x20) b.Append("\\u").Append(((int)ch).ToString("x4"));
      else b.Append(ch);
    }
    return b.Append('"').ToString();
  }

  // Says "this pid is a chat on <account>'s pinning login". Best effort: a
  // chat must never fail to start because of it.
  static string WriteMarker(Pinning pin, string sid, string cwd) {
    try {
      string dir = Path.Combine(Path.Combine(pin.Root, "pinning"), ".inuse");
      Directory.CreateDirectory(dir);
      int pid = Process.GetCurrentProcess().Id;
      string file = Path.Combine(dir, pid + ".json");
      string tmp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
      string json = "{\"v\":1,\"name\":" + Json(pin.Name) + ",\"pid\":" + pid + ",\"sessionId\":" + Json(sid) +
        ",\"cwd\":" + Json(cwd) + ",\"startedAt\":" + NowMs() + "}\n";
      File.WriteAllText(tmp, json, new UTF8Encoding(false));
      if (File.Exists(file)) File.Delete(file);
      File.Move(tmp, file);
      return file;
    } catch { return null; }
  }

  // The account's own Remote Control and Artifacts choices, when it has a
  // settings file that looks like a JSON object. Never when Claude Code
  // already passes --settings: a second one would replace its own.
  static string SettingsFile(Pinning pin, string[] a) {
    try {
      if (HasSettings(a)) return null;
      string f = Path.Combine(Path.Combine(pin.Root, "pinning"), pin.Name + ".settings.json");
      if (!File.Exists(f) || new FileInfo(f).Length > 65536) return null;
      string t = File.ReadAllText(f).Trim().TrimStart('\uFEFF').Trim();
      return t.StartsWith("{") && t.EndsWith("}") ? f : null;
    } catch { return null; }
  }

  static void Pump(Stream from, Stream to) {
    var buf = new byte[65536];
    try {
      int n;
      while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); }
    } catch { }
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimits info, int len);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  // The claude this starts dies when this process does, however it ends.
  static void TieToThis(Process child) {
    try {
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return;
      var info = new ExtendedLimits();
      info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimits))))
        AssignProcessToJobObject(job, child.Handle);
    } catch { }
  }

  static void Remove(string file) {
    if (file == null) return;
    try { File.Delete(file); } catch { }
  }

  static int Main(string[] a) {
    if (a.Length == 0) { Console.Error.WriteLine("claude-wrapper: no program to run"); return 2; }
    if (a[0] == "--switcher-selftest") { Console.Out.Write("claudeswitcher-wrapper ok " + Version + "\n"); Console.Out.Flush(); return 0; }
    string sid = SessionId(a);
    string cwd = Environment.CurrentDirectory;
    Pinning pin = Find(sid, cwd);

    var psi = new ProcessStartInfo(a[0]);
    var rest = new StringBuilder();
    for (int i = 1; i < a.Length; i++) rest.Append(i > 1 ? " " : "").Append(Quote(a[i]));
    string settings = pin != null ? SettingsFile(pin, a) : null;
    if (settings != null) rest.Append(rest.Length > 0 ? " " : "").Append("--settings ").Append(Quote(settings));
    psi.Arguments = rest.ToString();
    psi.UseShellExecute = false;
    // Input is inherited, not relayed: .NET's input writer would put a
    // byte-order mark in front of it whenever the console encoding has one.
    psi.RedirectStandardInput = false;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.CreateNoWindow = true;
    string marker = null;
    if (pin != null) {
      psi.EnvironmentVariables["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = pin.Dir;
      // A token in the environment would win over the pinning login.
      psi.EnvironmentVariables.Remove("CLAUDE_CODE_OAUTH_TOKEN");
      marker = WriteMarker(pin, sid, cwd);
    }

    Process child;
    try { child = Process.Start(psi); }
    catch (Exception e) { Remove(marker); Console.Error.WriteLine("claude-wrapper: couldn't start " + a[0] + ": " + e.Message); return 1; }
    TieToThis(child);
    var tout = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
    var terr = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
    tout.Start(); terr.Start();
    child.WaitForExit();
    tout.Join(); terr.Join();
    Remove(marker);
    return child.ExitCode;
  }
}
