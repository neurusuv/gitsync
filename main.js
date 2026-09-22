'use strict';

/*
 * Simple Git Sync — 最小 Obsidian 同步插件
 * 三件独立的事，各自有自己的定时器、互不绑定：定时 auto commit（默认关）、定时 auto pull、定时 auto push。
 * pull 正常情况走 fast-forward/无冲突合并；真遇到合并冲突时按"两阶段提交"处理（设计见
 * 冲突合并设计.md）：不产生额外文件、不留孤立分支——先把冲突文件统一提交成"较早/失败"的一侧
 * （这一步是真正的两父 merge commit，本地和远程在此正式汇合），紧接着再提交一次改成"较晚/胜出"
 * 的一侧、成为新 HEAD。谁早谁晚按该文件在本地/远程各自最后一次提交的时间戳判定，时间戳打平
 * 则退化比较作者时间，再打平就随机——git 历史不会因为判断错误而丢失内容，事后可以直接
 * revert 第二次提交或手动取回。
 * pull 前先刷一道"幻影修改"：内容与库里完全相同、只是 index 的 stat 缓存对不上的文件。
 * git diff 看不见它们，挡路检测也就看不见，但 git 合并时按 stat 判定，照样拒绝合并——
 * 对这类文件跑一次 git add（不会暂存任何内容）把 stat 刷新掉即可，见 refreshPhantomDirty。
 * pull 前再挡一道"挡路文件"：本机改过、且远程这次也改了的文件会让 git 直接拒绝合并，
 * 且拒绝时不产生任何冲突文件，上面那套两阶段处理根本没机会触发。只有这类文件会被先提交
 * 一版（逐个精确暂存，不是 add -A），工作区里其它没写完的东西一律不动。
 * push 前先看有没有未推送的提交，没有就跳过（不产生噪音）。
 * 每次可能产生提交的操作之前，都会顺手校一次 core.filemode，见 ensureRepoConfig。
 * 全部逻辑就在本文件，可通读。
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal } = require('obsidian');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULTS = {
  enabled: true,      // 总开关：关掉后三个定时器都停，手动命令仍可用
  commitInterval: 0,  // 分钟，0 = 关闭。完全独立于同步：定时把工作区改动打包提交一次（git add -A + commit），
                       // 不做任何冲突相关处理（本来就没有冲突，只是把当前状态存一版）。
  syncInterval: 10,   // 分钟，0 = 关闭。自动同步（pull→push 串行 + 收敛）的间隔。
                       // 旧版分 pullInterval/pushInterval 两个，已合并成这一个，见 onload 里的迁移。
  // pull 碰到"本机改过、远程也改了"的文件时：true = 只把这几个文件提交一版再合并；
  // false = 跳过这次 pull 并列出文件名，由人自己决定怎么处理。
  commitBlockersBeforePull: true,
  // 留空 = 自动：本机只有一个远程就直接用它；有多个则弹窗让人选一次，选完记在这里。
  // 不写死 'origin'：远程叫什么是每台机器自己的事（同一个仓库在这台叫 origin、在那台叫 cnb
  // 都很正常），写死会让配置一跨机同步就指向一个本机不存在的名字。
  remote: '',
  branch: '',         // 留空 = 自动用当前分支
  showNotices: true,  // 每次成功也弹提示（关掉则只在出错时提示）
  // 手动兜底：只有"动态探测"（见 resolveEnv）还是找不到 git 时才会用到。
  // 留空 = 不追加任何写死的目录，靠动态探测自己找。多个目录用英文逗号分隔，
  // 拼 PATH 时按当前系统分隔符（path.delimiter）现拼，同一份配置可跨 Mac/Windows 通用。
  extraPath: '',
};

// 关掉 LFS 过滤器的命令前缀：让 checkout / merge 把 LFS 文件按"指针原样"落盘，全程不联网。
// 专门用于服务端 LFS 对象损坏时的兜底重试——先保证合并能走完，内容随后再补。
const LFS_OFF = '-c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false';

// 网络类 git 命令（fetch / push）的三道闸门，见 gitNet()。
// 数字取值的依据：一次自动同步最多跑 3 轮 pull+push（见 runSync），若每次网络调用都要等满
// 默认的 3 分钟 exec 超时，一次同步能把 busy 这把共用锁占住十几分钟——期间连 auto commit
// 都被挡在门外，用户看到的就是"设了 1 分钟，五六分钟一点动静都没有"。
const NET_STALL_SECONDS = 20;            // git 自己判定"传输停滞"的秒数（http.lowSpeedTime）
const NET_HARD_TIMEOUT_MS = 45 * 1000;   // 上面那道没兜住时，exec 强杀的硬底线
// 抢 busy 锁最长等多久（见 acquire）。取 90 秒：大库一次 add -A + commit 的量级是十几秒，
// 留足余量；再等不到就说明前一件事本身出了问题，这次安静跳过，不要让请求越堆越多。
const LOCK_WAIT_MS = 90 * 1000;
// 判定"这次失败是远程/网络的锅"，而不是 non-fast-forward 之类真正值得下一轮 pull 完再试的失败。
// 只有前者才该立刻中止本次同步剩下的轮次——远程都没响应，重试也只是接着空等。
const NET_DOWN_PATTERN = /Operation too slow|Could not resolve host|unable to access|Failed to connect|Connection (refused|timed out|reset)|couldn't connect|Recv failure|Empty reply from server|early EOF|The remote end hung up|Authentication failed|could not read Username|BatchMode|timed out/i;

// 由本插件自动生成的提交标题前缀。用于"尖端永远不留两个连续自动提交"的折叠判断，
// 见 squashAutoCommits()。人写的提交绝不会以这些开头，所以不会被误折叠。
const AUTO_COMMIT_SUBJECT = /^(同步前自动保存：|同步合并（临时快照|同步合并：|同步前自动删除损坏的 LFS 文件|同步自动提交合并：|vault auto-commit: )/;

module.exports = class SimpleGitSync extends Plugin {
  async onload() {
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULTS, loaded);
    // 迁移：旧版把间隔拆成 pullInterval / pushInterval 两个设置，新版合并为 syncInterval。
    // 老配置文件里没有 syncInterval，就沿用旧的两个里较小的正值（都设 10 就还是 10；
    // 有一个设成 0 关掉的，取另一个正值；两个都关就保持关）。
    if (loaded.syncInterval === undefined && (loaded.pullInterval !== undefined || loaded.pushInterval !== undefined)) {
      const olds = [loaded.pullInterval, loaded.pushInterval].filter(n => typeof n === 'number' && n > 0);
      this.settings.syncInterval = olds.length ? Math.min(...olds) : 0;
      delete this.settings.pullInterval;
      delete this.settings.pushInterval;
      await this.saveData(this.settings); // 把迁移结果写回，之后就只认 syncInterval
    }
    this.busy = false;
    this.commitTimer = null;
    this.pullTimer = null;
    this.pushTimer = null;

    this.status = this.addStatusBarItem();
    this.status.style.cursor = 'pointer';
    this.status.setAttribute('aria-label', '点击切换自动同步开/关');
    this.status.onClickEvent(() => this.toggleEnabled());

    // 左侧栏按钮：手动点一下 = 先 pull 再 push（不受总开关影响，也不含 commit——commit 是独立动作）
    this.addRibbonIcon('refresh-cw', 'Git Sync：手动同步（pull + push）', () => this.syncNow());

    this.addSettingTab(new SimpleGitSyncSettings(this.app, this));

    this.addCommand({ id: 'sync-now', name: '手动同步（pull + push）', callback: () => this.syncNow() });
    this.addCommand({ id: 'commit-now', name: 'Commit now（打包提交当前改动）', callback: () => this.doCommit(true) });
    this.addCommand({ id: 'pull-now', name: 'Pull now（合并，冲突按时间顺序两阶段提交）', callback: () => this.doPull(true) });
    this.addCommand({ id: 'push-now', name: 'Push now', callback: () => this.doPush(true) });
    this.addCommand({ id: 'toggle-auto', name: '切换自动同步 开/关', callback: () => this.toggleEnabled() });

    // 不 await：Mac 上探测 PATH 要起一次登录 shell（最多 5 秒），不该拖慢 Obsidian 启动
    this.ensureRepoConfig();

    this.applyTimers();
  }

  // 仓库级环境修正。在每个可能产生提交的操作之前都调一次（不只是启动时），
  // 因为 .git/config 是本机文件、不进版本库，随时可能被别的工具、别的 AI 或换机器重置回默认值；
  // 只有在真正要提交之前校准，才能保证那一刻的提交是干净的。
  // 代价是每项一次 `git config --get`，快到可以忽略；已经是目标值就直接返回，不做无谓写盘。
  //
  // 每一项都必须是独立的一个方法、在这里逐个 await——别图省事写成一个 try 块里连着判断。
  // 那样第一项"已经是目标值"的早返回会把后面所有项一起跳过（2026-08-20 加 autocrlf 时
  // 就这么写错过一次：Windows 的 git init 默认已经把 filemode 设成 false，于是 autocrlf
  // 那段一次都没被执行，沙箱一跑才发现）。
  async ensureRepoConfig() {
    await this.clearStaleLocks();
    await this.ensureFilemode();
    await this.ensureAutocrlf();
    await this.ensureFrozenStateFiles();
  }

  // 每台机器各自不同、却又必须留在版本库里的"每机状态文件"。
  // 留在库里是为了新机器 clone 后有完整文件可用；不冻结则每次同步都被它们挡住。
  static get STATE_FILES() {
    return [
      '.obsidian/workspace.json',                       // 窗口布局、打开的标签页
      '.obsidian/plugins/notebook-navigator/data.json', // 插件运行态
    ];
  }

  // ——— 每机状态文件自动冻结（2026-09-01 加）———
  //
  // 不冻结的后果：git status 里这两个文件永远 modified，pull 每次都被
  //   "Your local changes to the following files would be overwritten by merge" 顶回，
  //   插件反复制造只含它们的"同步合并"提交，本地 behind 越攒越多。
  //   2026-09-01 实测就是它们俩把同步整个挡死（远端已领先 5 个提交）。
  //
  // 为什么必须由代码每次开机自己确认、而不是写进文档让人手工跑一次：
  //   skip-worktree 标记只存在于 .git/index（二进制、每个 clone 独有），**不进提交、不随 push 分发**，
  //   .gitignore / .gitattributes / .git/config 里都存不下——git 根本没有分发该标记的机制。
  //   本库文档 2026-07-30 就写了"新 clone 必做一步"，2026-08-20 实测发现 Windows 端从没执行过，
  //   2026-09-01 再查**还是没执行**，同一个坑挡了两次同步。
  //   **写在文档里、没有任何机器去跑的规则，等于不存在。**
  //
  // 为什么不用 .gitignore：对已跟踪文件无效（本库 .gitignore 里曾长期躺着 workspace.json 那一行，
  //   实际一天都没生效过，2026-07-30 已删）。为什么不用 git rm --cached：那会让新 clone 缺文件。
  //   只有 skip-worktree 能同时满足"库里有完整版本"和"本机改动不可见"。
  //
  // 文件已经脏了怎么办：**什么都不用做，直接打标记**（2026-09-01 实测确认）。
  //   git 允许对一个已修改的文件打 skip-worktree：打上之后它就不再看工作区那一份，
  //   status 立刻变干净，而磁盘上的文件原样留着、Obsidian 继续用它，内容一个字节都不丢。
  //   ⛔ 别先 git add 一次"保住内容"——那纯属多余，还会把本机的窗口布局暂存进去、
  //   顺着下一次提交推给所有其它机器（初版就这么写的，实测发现后去掉）。
  //   ⛔ 更别 checkout 丢弃——那会把用户正开着的标签页布局当场抹掉。
  //
  // 远端若改了这两个文件，pull 不会因为冻结而失败——freeFrozenBlockers() 会临时解冻、合并完再重冻。
  async ensureFrozenStateFiles() {
    try {
      const already = new Set((await this.frozenFiles()).map(f => f.path));
      const froze = [];
      for (const f of SimpleGitSync.STATE_FILES) {
        if (already.has(f)) continue;
        // 没被跟踪的就跳过：ls-files 对未跟踪路径输出为空，此时打标记会直接报错。
        const tracked = await this.git(`-c core.quotepath=false ls-files -- ${this.quotePath(f)}`);
        if (tracked.code !== 0 || !tracked.out) continue;
        // 脏也直接打：skip-worktree 打上后 git 不再看工作区那份，磁盘文件原样保留。
        const r = await this.git(`update-index --skip-worktree -- ${this.quotePath(f)}`);
        if (r.code === 0) froze.push(f);
      }
      if (froze.length) {
        this.notify('已冻结每机状态文件：' + froze.join('、') +
          '。它们每台机器内容都不一样，不冻结就会永远显示为已修改并挡住每一次合并；' +
          'skip-worktree 标记只存在于本机 .git/index、不随 push 分发，所以每台机器都要各自打一次。');
      }
    } catch (e) { /* 冻结失败不该阻断同步本身 */ }
  }

  // .git 通常是目录；在 worktree / submodule 里它是一个文本文件，内容形如 "gitdir: <路径>"。
  // 锁文件永远躺在真正的 git 目录里，所以这一步必须先解析出它，不能想当然拼 vault/.git。
  gitDirPath() {
    try {
      const p = path.join(this.vaultPath(), '.git');
      const st = fs.statSync(p);
      if (st.isDirectory()) return p;
      const m = fs.readFileSync(p, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const target = m[1];
      return path.isAbsolute(target) ? target : path.resolve(this.vaultPath(), target);
    } catch (e) { return null; }
  }

  // ——— 僵尸锁清理：静置超过 5 分钟的 .lock 一律删掉（2026-09-01 王超定）———
  //
  // 病理：git 每次要写 ref 或 index，都先创建一个同名 .lock 占位、写完再改名覆盖原文件。
  //   进程被强杀、Obsidian 崩溃、TortoiseGit 的 TGitCache 跟本插件抢同一个仓库、
  //   VerySync 在 git 写到一半时把目录搬走——任何一种都会把 .lock 留在原地。
  //   此后 git 每次再动那个 ref 就报
  //     fatal: cannot lock ref 'HEAD': Unable to create '.../.git/HEAD.lock': File exists
  //   **而且会一直报下去**：没有任何东西会自己来收这个尸，同步就此永久停摆，
  //   插件却还会照常弹一句"没有需要推送的提交"，看起来像一切正常。
  //   2026-09-01 实测：HEAD.lock 是 0 字节、08:24 创建，10:58 发现时已经挡了 2.5 小时，
  //   期间本机没有任何 git 进程在跑。
  //
  // 为什么阈值取 5 分钟：正常写 ref 是毫秒级；本库最慢的 LFS 批量操作虽能跑几十分钟，
  //   但那期间锁文件的 mtime 会被持续刷新，**静止**5 分钟以上的锁基本可断定主人已经不在。
  //   再短会掐掉正在进行的操作，再长则失去意义。
  //
  // 为什么不去枚举"有没有 git 进程在跑"：跨平台进程枚举（tasklist / ps）代价高、口径不一，
  //   而且本机同时有多个仓库时"有 git 进程"根本不代表"它锁的是这个仓库"。mtime 是更准的判据。
  //
  // ⚠️ 只删以 .lock 结尾的锁文件本身，绝不碰 MERGE_HEAD / ORIG_HEAD / CHERRY_PICK_HEAD
  //   这类记录合并中间状态的真文件——删掉那些会让一次进行到一半的合并彻底失去上下文。
  async clearStaleLocks() {
    const STALE_MS = 5 * 60 * 1000;
    try {
      const gitDir = this.gitDirPath();
      if (!gitDir) return;
      const now = Date.now();
      const found = [];
      const scan = (dir, depth, maxDepth) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) { if (depth < maxDepth) scan(full, depth + 1, maxDepth); continue; }
          if (!ent.name.endsWith('.lock')) continue;
          try {
            const st = fs.statSync(full);
            const age = now - st.mtimeMs;
            if (age >= STALE_MS) found.push({ full, ageMin: Math.round(age / 60000) });
          } catch (e) { /* stat 不到就当它不存在 */ }
        }
      };
      // HEAD.lock / index.lock / config.lock / packed-refs.lock 都在 .git 根这一层；
      // 分支与 tag 的锁在 refs/ 下，reflog 的锁在 logs/ 下。只扫这三处，不整库递归。
      scan(gitDir, 0, 0);
      scan(path.join(gitDir, 'refs'), 0, 3);
      scan(path.join(gitDir, 'logs'), 0, 3);
      if (!found.length) return;
      const removed = [];
      for (const f of found) {
        try {
          fs.unlinkSync(f.full);
          removed.push(path.relative(gitDir, f.full) + '（静置 ' + f.ageMin + ' 分钟）');
        } catch (e) { /* 删不掉就留着，下一轮再试；绝不因此阻断同步 */ }
      }
      if (removed.length) {
        this.notify('已清理僵尸锁：' + removed.join('、') +
          '。git 写 ref/index 前会建 .lock 占位，进程被强杀或多个工具抢同一个仓库就会把它留在原地，' +
          '此后每次同步都报 cannot lock ref，直到有人手工删除。');
      }
    } catch (e) { /* 锁清理失败不该阻断同步本身 */ }
  }

  // core.filemode 到底修的是什么：
  //   Mac 上提交的文件模式是 100755，Windows 端的 git 一律只认 100644，于是同一批文件
  //   在 Windows 上被判成"已修改"——内容一个字没变，git status 却永远非空。
  //   后果不只是噪音：工作区永远不可能干净，pull 每次都被挡住，push 也就一直落后于远程。
  //   关掉模式位检测后 git 忽略这个差异；纯笔记库不依赖可执行位，没有副作用。
  async ensureFilemode() {
    try {
      const cur = await this.git('config --get core.filemode');
      if (cur.out === 'false') return;
      const r = await this.git('config core.filemode false');
      if (r.code === 0) {
        this.notify('已设置 core.filemode=false：忽略文件模式位，避免 Mac/Windows 之间整批文件被误判为"已修改"');
      }
    } catch (e) { /* 环境修正失败不该阻断同步本身 */ }
  }

  // core.autocrlf 校准：跟 core.filemode 是同一类病——环境配置让 git 把没改过的文件判成"已修改"，
  // 工作区永远不干净，pull 永远被挡。只是这一个更阴险，因为 git diff 看不见它。
  //
  // 病理（2026-08-20 在本库 Windows 端实测确认）：
  //   core.autocrlf=true 时，git 检出会把 LF 转成 CRLF 写盘，并把**转换后的字节数**记进
  //   index 的 stat 缓存。这个库同时还被 VerySync 在 Mac/Windows 之间搬运工作区，Mac 那份是
  //   LF，一覆盖过来文件就变短了。git 比对 stat 时只看 size，size 对不上就判"已修改"——
  //   可内容经 clean 过滤后跟 blob 一模一样，所以 git diff 是空的。
  //   实测样本 3-wiki/3B-所以是/KTH78XX成对料号差的是滤波时间常数.md：
  //     git ls-files --debug → size: 11033   ← index 记的 CRLF 版尺寸
  //     stat -c %s           → 10928         ← 磁盘上的 LF 版
  //     git hash-object      → 与 index blob 完全相同
  //   ⚠️ git update-index --refresh / --really-refresh 都清不掉，只会反复打印 needs update。
  //
  // 为什么选 input 而不是 false：
  //   false 只是"检出时不再转换"，但磁盘上还躺着一大批老的 autocrlf=true 检出留下的 CRLF 文件
  //   （本库实测 README.md 55 行、AGENTS.md 41 行 CRLF，而 blob 是纯 LF）。这些文件一旦被改动
  //   提交，整篇会按 CRLF 重新存进 blob，diff 变成"全文重写"——2026-08-20 当天连撞两次，
  //   一个 18 行的改动提交成 143 增 161 删。input 的提交方向始终把 CRLF 折回 LF，从根上避免。
  //   检出方向 input 不转换，磁盘拿到的就是 blob 字节，size 天然对得上，幻影不再产生。
  async ensureAutocrlf() {
    try {
      const cur = await this.git('config --get core.autocrlf');
      if (cur.out === 'input') return;
      const r = await this.git('config core.autocrlf input');
      if (r.code === 0) {
        this.notify('已设置 core.autocrlf=input：检出不改行尾、提交统一折成 LF，避免同步软件盖回来的文件被误判为"已修改"而挡住合并');
      }
    } catch (e) { /* 环境修正失败不该阻断同步本身 */ }
  }

  // 手动同步 = 自动同步 = 同一套：pull → push 串行，必要时收敛几轮。
  // 手动按钮和定时器都走这里，行为完全一致——这样"手动能成、自动不行"的老毛病就不存在了。
  async syncNow() { await this.runSync(true); }

  // 一次完整同步：pull 然后 push，串行。
  // 为什么要循环：pull 合并出新提交后要 push；而 push 的这段时间里远程可能又被别的机器推了新东西，
  // 于是这次 push 被拒——下一轮再 pull 把新东西并进来、再 push，直到"没得拉也没得推"为止。
  // 封顶 3 轮，避免两台机器高频对推时在这儿空转太久。
  async runSync(manual) {
    // 防重入排在最前面：doPull/doPush 现在会排队等锁，一次同步可能跨过下一个定时点。
    // 不挡住的话请求会越堆越多，最后几十个 runSync 排成一串轮流跑，比不同步还糟。
    // 也顺带保证下面的消毒不会两份同时在改同一批文件名。
    if (this._syncRunning) { if (manual) this.notify('已有一次同步在进行中'); return; }
    this._syncRunning = true;
    try {
      // 出口消毒永远排在最前面：先把本机的跨平台非法文件名改成兼容形式、单独提一版，
      // 再做 pull/push。放在这里而不是 doCommit 里，是因为非法名必须在任何东西被推出去之前
      // 就消失——一旦推上远程，别的 Windows 机器就再也 pull 不动这条分支了。
      if (!await this.sanitizeLocalNames(manual)) {
        this.setStatus('Git Sync: 已中止（非法文件名未能修正）');
        return;
      }
      this._netDown = false;
      for (let round = 0; round < 3; round++) {
        this._pullUpToDate = false;
        this._pushNothing = false;
        await this.doPull(manual);
        // 远程都连不上，本轮 push 必然是同样的空等——直接收工，把 busy 这把锁还给 auto commit，
        // 别拿三轮网络超时把接下来几分钟全占死。
        if (this._netDown) break;
        await this.doPush(manual);
        if (this._netDown) break;
        if (this._pullUpToDate && this._pushNothing) break; // 这一轮既没拉到也没推出 = 已收敛
      }
    } finally { this._syncRunning = false; }
  }

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveData(this.settings);
    this.applyTimers();
    new Notice('[Git Sync] 自动同步已' + (this.settings.enabled ? '开启' : '关闭'));
  }

  onunload() { this.clearTimers(); }

  clearTimers() {
    if (this.commitTimer) window.clearInterval(this.commitTimer);
    if (this.syncTimer) window.clearInterval(this.syncTimer);
    // 错开用的那一发 setTimeout 也要清掉，否则改一次设置就多留一个待触发的定时器，
    // 反复改几次设置之后同步会一分钟内连跑好几次。
    if (this.syncKick) window.clearTimeout(this.syncKick);
    this.commitTimer = this.syncTimer = this.syncKick = null;
  }

  applyTimers() {
    this.clearTimers();
    if (!this.settings.enabled) { this.setStatus('Git Sync: 已停用'); return; }
    // 可选的定时 commit 仍独立（默认关）。
    if (this.settings.commitInterval > 0) {
      this.commitTimer = window.setInterval(() => this.doCommit(false), this.settings.commitInterval * 60000);
    }
    // 自动同步只有一个定时器，跑的是 runSync（pull→push 串行 + 收敛），和手动按钮同一套。
    // 老版本把 pull、push 拆成两个独立定时器，导致 push 常在没 pull 的情况下先跑、被 busy 跳过，
    // 或 pull 出的新提交等不到 push——"自动同步从来没真正成功"就是这么来的。
    if (this.settings.syncInterval > 0) {
      const period = this.settings.syncInterval * 60000;
      // 第二道保险：两个周期相同的定时器如果同刻创建，会永远在同一个 tick 里一起触发，
      // 见 acquire() 上面那段。排队等锁已经能兜住，这里再把同步整体推后半个周期，
      // 让常态下两件事根本不撞面——省掉每分钟一次毫无意义的等待。
      this.syncKick = window.setTimeout(() => {
        this.syncTimer = window.setInterval(() => this.runSync(false), period);
        this.runSync(false);
      }, Math.floor(period / 2));
    }
    this.setStatus('Git Sync: 就绪');
  }

  setStatus(text) { if (this.status) this.status.setText(text); }

  // 抢 busy 锁：抢不到就干等一会儿，而不是扭头就走。
  //
  // 为什么非等不可——这是"auto commit 每分钟都在跑、auto push 一次都轮不上"的真正原因：
  // busy 是 commit / pull / push 共用的一把锁；当 commitInterval 和 syncInterval 填成同一个值
  // （比如都填 1），两个 setInterval 是在 applyTimers 里同一毫秒创建的、周期又完全一样，
  // 此后**每一次都落在同一个事件循环 tick 里**，而 commitTimer 注册在前。
  // 于是每分钟都是：doCommit 先拿到 busy → runSync 紧接着触发 → doPull/doPush 看到 busy=true
  // 原地返回 → 三轮循环空转 → 本次同步什么也没做。而且这个状态一旦形成就永久保持，
  // 不会自己好。2026-09-10 实测：13:12 成功推过一次之后，本地又攒了 4 个 auto-commit，
  // 远程分支纹丝不动，日志里连一条失败记录都没有——因为它压根没走到网络那一步。
  //
  // 靠"把两个定时器错开"只能降低概率：周期相同的两个定时器迟早还会再撞上，
  // 何况 commit 本身耗时会变。所以这里改成真的排队等，错开只作为第二道保险。
  //
  // JS 是单线程的：下面 while 判断和 this.busy = true 之间没有 await，中间插不进第二个抢锁者。
  async acquire(maxWaitMs) {
    const deadline = Date.now() + (maxWaitMs || 0);
    while (this.busy) {
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 200));
    }
    this.busy = true;
    return true;
  }

  vaultPath() {
    const a = this.app.vault.adapter;
    return a.getBasePath ? a.getBasePath() : a.basePath;
  }

  // 探测一份"能找到 git 的 PATH"，不写死任何具体安装目录，缓存在 this._resolvedPath。
  // - Windows/Linux：Obsidian 作为普通 GUI 进程一般就继承了完整的用户/系统 PATH，直接用 process.env.PATH。
  // - macOS：Finder/Dock 启动的 GUI App 不会加载 ~/.zshrc、~/.zprofile 等登录 shell 配置文件，
  //   PATH 里常常没有 /opt/homebrew/bin 之类 git 所在目录。用登录 shell 跑一遍 `echo $PATH`，
  //   直接问系统"你真正的 PATH 是什么"，而不是猜测/硬编码具体安装路径——git 装哪儿都不怕。
  resolveEnv() {
    if (this._resolvedPath) return Promise.resolve(this._resolvedPath);
    return new Promise((resolve) => {
      const finish = (p) => { this._resolvedPath = p; resolve(p); };
      if (process.platform !== 'darwin') { finish(process.env.PATH || ''); return; }
      const shell = process.env.SHELL || '/bin/zsh';
      exec(`${shell} -ilc 'echo $PATH'`, { timeout: 5000 }, (e, out) => {
        const got = (out || '').trim();
        finish(got || process.env.PATH || '');
      });
    });
  }

  // 跑一条 git 命令，返回 {code, out, err}。
  // extraEnv：追加/覆盖的环境变量（如做临时索引改名时的 GIT_INDEX_FILE），一般不用传。
  // LFS 批量拉取/检出在大库上可能跑很久（本库 6500+ 对象、3.6 GB），远超默认 3 分钟超时；
  // 被超时杀掉会让"补内容"半途而废、进而把还能救回来的文件误判成损坏。这类命令单独放宽到 30 分钟。
  async gitLong(args) { return this.git(args, undefined, 30 * 60 * 1000); }

  // 网络类 git 命令（fetch / push）专用，不要用普通的 git() 跑它们。
  //
  // 为什么要单开一个：远程"TCP 端口开着、HTTP 却一个字节都不回"时（服务进程假死是典型场景，
  // 2026-09-10 实测本库的远程 10.10.10.218:3000 就是这样：端口连得上、ping 0ms，
  // curl 却一直挂着不返回），git 会老老实实等下去，直到 exec 的 3 分钟 timeout 把它杀掉。
  // 每分钟一次的定时同步于是变成"三分钟里什么都不发生"；而 busy 是三件事共用的一把锁，
  // auto commit 也跟着被挡住——表现就是插件像死了一样，看不出任何提示。
  //
  // 三道闸门，从软到硬：
  //   1. http.lowSpeedLimit / lowSpeedTime：让 git 自己在连续 20 秒收不到数据时干净地放弃。
  //      首选这条，因为是 git 主动退出，会把 git-remote-http 子进程一并收干净；
  //      靠 exec 杀父进程则可能留下还连着的孤儿子进程。
  //   2. GIT_TERMINAL_PROMPT=0 与 ssh BatchMode：凭据不对时立刻失败。无人值守的定时任务里
  //      弹一个交互式密码提示，等同于永久挂起。
  //   3. exec 45 秒硬超时：前两道都没兜住时的底线。
  //
  // 返回值在 git() 的基础上多一个 netDown：true 表示"这次失败是网络/远程的锅"。
  async gitNet(args) {
    const opts = `-c http.lowSpeedLimit=1 -c http.lowSpeedTime=${NET_STALL_SECONDS}`;
    const env = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    };
    const r = await this.git(`${opts} ${args}`, env, NET_HARD_TIMEOUT_MS);
    r.netDown = r.code !== 0 && (r.killed || NET_DOWN_PATTERN.test(`${r.err}\n${r.out}`));
    // 被硬超时掐死的那一路 stderr 是空的，这里补一句人话，免得弹窗只显示"未知错误"。
    if (r.killed && !r.err) {
      r.err = `远程 ${NET_HARD_TIMEOUT_MS / 1000} 秒内没有任何响应，已放弃本次连接`;
    }
    return r;
  }

  // 网络不通时统一的收尾：记一个标记让 runSync 别再跑剩下的轮次，并把原因说清楚。
  // 单独抽出来是因为 doPull 和 doPush 两处要说同一件事，措辞必须一致——
  // 否则同一个故障在通知栏里出现两种说法，看的人会以为是两个毛病。
  reportNetDown(where, detail) {
    this._netDown = true;
    this.notify(`${where}失败：连不上远程（本地提交都还在，没有丢东西）。${detail}`, true);
    this.setStatus('Git Sync: 远程不可达');
  }

  async git(args, extraEnv, timeoutMs) {
    const dynamicPath = await this.resolveEnv();
    const env = Object.assign({}, process.env);
    // 手动兜底目录（extraPath，逗号分隔、跨平台通用）拼在最前面，动态探测到的 PATH 拼在后面；
    // 用 path.delimiter 按当前系统分隔符现拼，不再硬编码 ':'（那样在 Windows 下会拼出一坨不可解析的垃圾）。
    const extraDirs = (this.settings.extraPath || '').split(',').map(s => s.trim()).filter(Boolean);
    env.PATH = extraDirs.concat(dynamicPath.split(path.delimiter).filter(Boolean)).join(path.delimiter);
    if (extraEnv) Object.assign(env, extraEnv);
    return new Promise((resolve) => {
      exec('git ' + args, { cwd: this.vaultPath(), env, timeout: timeoutMs || 180000, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => {
        // killed=true 表示进程是被上面的 timeout 掐死的，不是 git 自己退出的。
        // 这种情况 stderr 往往是空的，报错信息只能由调用方补，见 gitNet()。
        resolve({ code: e ? (e.code || 1) : 0, out: (out || '').trim(), err: (err || '').trim(), killed: !!(e && e.killed) });
      });
    });
  }

  // 路径里可能有空格/中文/括号，统一加引号，cmd.exe 和 POSIX sh 都认双引号
  quotePath(p) { return '"' + String(p).replace(/"/g, '\\"') + '"'; }

  // 用临时文件传 commit message，避免多行/中文/特殊字符在 shell 里被引号规则搞乱
  // （这也是本库文档里一贯要求的"中文多行 message 走文件"的做法）
  async commitWithMessage(message) {
    const tmp = path.join(os.tmpdir(), `git-sync-msg-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tmp, message, 'utf8');
    try {
      return await this.git(`commit -F ${this.quotePath(tmp)}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略删除失败，系统临时目录迟早会清 */ }
    }
  }

  // ——— Windows 非法文件名自动兜底 ———
  // NTFS 禁止文件名里出现 \ / : * ? " < > | 及控制字符。/ 和 \ 是路径分隔符另说，
  // 真正会卡死同步的是 : * ? " < > |（Mac/Linux 全部合法）。把它们逐个映射成外观相近的全角字符，
  // 既合法、又保留可读性、还一眼能看出是被替换过的，日后要规范改名也认得出来。
  //
  // 2026-08-07 补全：光查字符是不够的。那次把 Windows 端同步彻底卡死的六个文件里，
  // 只有 `**2026-07-27` 被这条字符规则救到，`1.` `2.` `3.` `4.` 四个**以点结尾**的
  // 全部漏网，合并照样中止。Windows 的文件名限制除了字符还有三条：
  //   - 不能以 . 或空格结尾（资源管理器会静默截掉，git checkout 直接报 invalid path）
  //   - CON/PRN/AUX/NUL/COM1-9/LPT1-9 是设备保留名，带扩展名也一样不行
  //   - 不允许控制字符（0x01-0x1F）
  // 下面四条规则一起查，缺一条就会重演同一场事故。
  static get WIN_ILLEGAL_MAP() {
    return { ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
  }
  static get WIN_RESERVED() {
    return new Set([
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ]);
  }
  // 单个路径段是否为 Windows 非法名
  isIllegalWinSeg(seg) {
    if (!seg) return false;
    if (/[:*?"<>|]/.test(seg)) return true;
    if (/[\x01-\x1f]/.test(seg)) return true;
    if (/[. ]$/.test(seg)) return true;                       // 以点或空格结尾
    if (SimpleGitSync.WIN_RESERVED.has(seg.split('.')[0].toUpperCase())) return true;
    return false;
  }
  // 整条路径里只要有任意一段非法就算非法（旧名保留，调用方仍在用）
  hasIllegalWinChar(name) {
    return String(name).split('/').some(seg => this.isIllegalWinSeg(seg));
  }
  sanitizeWinName(p) {
    const map = SimpleGitSync.WIN_ILLEGAL_MAP;
    // 只处理各路径段内部，保留 / 作分隔符
    return String(p).split('/').map(seg => {
      if (!seg) return seg;
      let s = seg.replace(/[:*?"<>|]/g, c => map[c]).replace(/[\x01-\x1f]/g, '');
      // 结尾的点/空格换成全角等价物：全角句点合法，且一眼看得出被改过。
      // 直接删掉会让 `1.` `2.` `3.` `4.` 全部塌成 `1` `2` `3` `4` 之外还可能撞名，
      // 换字符则一一对应、可逆、不产生新冲突。
      s = s.replace(/[. ]+$/, m => m.replace(/\./g, '．').replace(/ /g, '␠'));
      if (SimpleGitSync.WIN_RESERVED.has(s.split('.')[0].toUpperCase())) {
        const dot = s.indexOf('.');
        s = dot < 0 ? s + '_' : s.slice(0, dot) + '_' + s.slice(dot);
      }
      return s;
    }).join('/');
  }

  // ——— 出口消毒：每次同步开始前，先把本机工作区里的非法名改成兼容形式并单独提一版 ———
  // 为什么必须有这一步：原先只有 sanitizeIncomingIfNeeded 这个"入口"兜底，且只在 Windows 跑。
  // 也就是说 Mac 可以随手造出非法名、照常提交推送，卡死留给 Windows 事后收拾；而每收拾一次
  // 就要机器改一次名，改名又可能打断 [[双链]]。把关口挪到出口，非法名压根不进 git 历史。
  //
  // 覆盖已跟踪文件和未被 .gitignore 忽略的新文件（后者正是上次事故的来源：一条 shell 命令
  // 在库根误建的空文件，还没进 git 就已经在工作区里了）。
  async localIllegalNames() {
    const r = await this.git('-c core.quotepath=false status --porcelain -z --untracked-files=all');
    if (r.code !== 0) return [];
    const seen = new Set();
    const out = [];
    for (const rec of r.out.split('\0')) {
      if (!rec) continue;
      // porcelain -z 的记录形如 "XY path"。重命名记录是 "R  new\0old"，会被拆成两条，
      // 第二条（旧路径）不带状态前缀。只有确实匹配两位状态码+空格才剥前缀，
      // 否则像 `a b/c.md` 这种第三个字符恰好是空格的路径会被切成 `/c.md`。
      const m = /^[ MADRCU?!][ MADRCU?!] /.exec(rec);
      const p = m ? rec.slice(3) : rec;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (this.hasIllegalWinChar(p)) out.push({ from: p, to: this.sanitizeWinName(p) });
    }
    // 已跟踪但本次没改动的文件，status 不会列出来，单独再扫一遍索引
    const ls = await this.git('-c core.quotepath=false ls-files');
    if (ls.code === 0) {
      for (const p of this.gitPathLines(ls.out)) {   // 必须解码：带 \ 或 " 的名字 git 会加引号
        if (!p || seen.has(p)) continue;
        seen.add(p);
        if (this.hasIllegalWinChar(p)) out.push({ from: p, to: this.sanitizeWinName(p) });
      }
    }
    return out;
  }

  // 每次 runSync 开头调用。返回 true 表示"已处理完（无论有没有改动）可以继续"，
  // false 表示出错、调用方应中止本轮同步。
  async sanitizeLocalNames(manual) {
    let entries;
    try {
      entries = await this.localIllegalNames();
    } catch (e) {
      this.notify('检查非法文件名时出错：' + (e && e.message ? e.message : String(e)), true);
      return false;
    }
    if (!entries.length) return true;

    this.setStatus('Git Sync: 正在修正非法文件名…');
    const root = this.vaultPath();
    const done = [];
    for (const e of entries) {
      let to = e.to;
      // 目标已存在就加序号，绝不覆盖别人的文件
      let n = 2;
      while (fs.existsSync(path.join(root, to)) && to !== e.from) {
        const dot = path.basename(to).lastIndexOf('.');
        const dir = path.dirname(to) === '.' ? '' : path.dirname(to) + '/';
        const base = path.basename(to);
        to = dir + (dot > 0 ? `${base.slice(0, dot)}_${n}${base.slice(dot)}` : `${base}_${n}`);
        n++;
      }
      if (to === e.from) continue;
      const abs = { from: path.join(root, e.from), to: path.join(root, to) };
      try {
        fs.mkdirSync(path.dirname(abs.to), { recursive: true });
        fs.renameSync(abs.from, abs.to);
      } catch (err) {
        this.notify(`重命名 ${e.from} 失败：` + (err && err.message ? err.message : String(err)), true);
        return false;
      }
      // 逐个精确暂存，绝不用 add -A（工作区里没写完的其它改动不该被这一步卷进来）
      await this.git(`add -- ${this.quotePath(to)}`);
      await this.git(`add -- ${this.quotePath(e.from)}`);   // 记录旧路径的删除（未跟踪文件会静默失败，无妨）
      done.push({ from: e.from, to });
    }
    if (!done.length) return true;

    const msg =
      `同步前置：修正 ${done.length} 个跨平台非法文件名\n\n` +
      'Windows 不允许文件名含 : * ? " < > | 或控制字符、不允许以点或空格结尾、\n' +
      '也不允许 CON/PRN/AUX/NUL/COM1-9/LPT1-9 这些设备保留名。这类名字在 Mac/Linux 上\n' +
      '完全合法，一旦进入 git 历史，任何 Windows 机器 checkout 到它就报 invalid path、\n' +
      '合并中止且不产生冲突文件，同步会永久卡死在这条分支上。\n\n' +
      '本提交由 simple-git-sync 在同步开始前自动生成，只做改名、不含任何内容改动。\n' +
      '这是机器改名，可能使指向它们的 [[双链]] 失效；建议之后用 obsidian-cli 规范改名并修复反链。\n\n' +
      done.map(e => `- ${e.from}\n  → ${e.to}`).join('\n') + '\n';
    const c = await this.commitWithMessage(msg);
    if (c.code !== 0) {
      this.notify('非法文件名已改好，但提交失败：' + (c.err || c.out).split('\n')[0], true);
      return false;
    }
    this.notify(
      `已自动修正 ${done.length} 个 Windows 非法文件名并单独提交：\n` +
      done.slice(0, 5).map(e => `${e.from}\n  → ${e.to}`).join('\n') +
      (done.length > 5 ? `\n…共 ${done.length} 个` : ''),
      true
    );
    return true;
  }

  // 扫描某个 ref 的树，列出所有含 Windows 非法字符的文件（连同其 mode、blob sha）。
  // 纯读树，不检出任何文件，因此在 Windows 上对着非法名也能安全跑。
  async invalidWinEntries(ref) {
    const r = await this.git(`-c core.quotepath=false ls-tree -r ${ref}`);
    if (r.code !== 0) return [];
    const out = [];
    for (const line of r.out.split('\n')) {
      // 格式：<mode> <type> <sha>\t<path>
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      const from = line.slice(tab + 1);
      if (meta.length >= 3 && meta[1] === 'blob' && this.hasIllegalWinChar(from)) {
        out.push({ mode: meta[0], sha: meta[2], from, to: this.sanitizeWinName(from) });
      }
    }
    return out;
  }

  // 只在 Windows 上、且远程树里确有非法名时才动作。返回：
  //   null                    —— 无需处理
  //   { err }                 —— 处理出错，调用方应中止
  //   { commit, renames }     —— 已生成"消毒过"的提交（顶在 ref 之上），改用它来合并
  async sanitizeIncomingIfNeeded(ref) {
    if (process.platform !== 'win32') return null;
    const entries = await this.invalidWinEntries(ref);
    if (!entries.length) return null;

    // 走一个临时索引文件，read-tree 把远程整棵树读进去，再在索引里把非法名换成合法名，
    // 全程不碰工作区（那个非法名一次都不会落到磁盘），最后 write-tree + commit-tree。
    const idx = path.join(os.tmpdir(), `git-sync-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_INDEX_FILE: idx };
    // Windows 默认 core.protectNTFS=true 会拒绝任何触碰非法名的索引操作（连读进索引都不行）。
    // 这里全程只在索引/对象库里操作、绝不检出到工作区，所以关掉它是安全的——
    // 真正会被 NTFS 拒之门外的是"把非法名写成磁盘文件"，而我们恰恰是在避免那一步。
    const guard = '-c core.protectNTFS=false -c core.protectHFS=false';
    try {
      let r = await this.git(`${guard} read-tree ${ref}`, env);
      if (r.code !== 0) return { err: 'read-tree: ' + (r.err || r.out) };
      for (const e of entries) {
        // 新名字加进索引（三参数 cacheinfo，避免路径里含逗号时被误拆）
        r = await this.git(`${guard} update-index --add --cacheinfo ${e.mode} ${e.sha} ${this.quotePath(e.to)}`, env);
        if (r.code !== 0) return { err: `加入 ${e.to}: ` + (r.err || r.out) };
        // 旧的非法名从索引里删掉
        r = await this.git(`${guard} update-index --force-remove -- ${this.quotePath(e.from)}`, env);
        if (r.code !== 0) return { err: `移除 ${e.from}: ` + (r.err || r.out) };
      }
      const tree = await this.git(`${guard} write-tree`, env);
      if (tree.code !== 0) return { err: 'write-tree: ' + (tree.err || tree.out) };
      const msg =
        `同步兜底：改掉 ${entries.length} 个 Windows 非法文件名\n\n` +
        '下列文件名含 Windows 不允许的字符（: * ? " < > |），在 Windows 上无法检出，\n' +
        '会导致合并中止、同步永久卡死。已把非法字符替换为外观相近的全角字符，使其在所有平台都合法。\n' +
        '这是机器自动改名，可能使指向它们的 [[双链]] 失效；建议之后在 Mac 上用 obsidian-cli 规范改名并修复反链。\n\n' +
        entries.map(e => `- ${e.from}\n  → ${e.to}`).join('\n') + '\n';
      const commit = await this.commitTreeWithMessage(tree.out, ref, msg, env);
      if (commit.code !== 0) return { err: 'commit-tree: ' + (commit.err || commit.out) };
      return { commit: commit.out, renames: entries };
    } finally {
      try { fs.unlinkSync(idx); } catch (e) { /* 临时索引删不掉无所谓，系统迟早清 */ }
    }
  }

  // commit-tree 版的“消息走临时文件”，避免中文多行在 shell 里被引号规则搞坏
  async commitTreeWithMessage(tree, parent, message, env) {
    const tmp = path.join(os.tmpdir(), `git-sync-ct-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tmp, message, 'utf8');
    try {
      return await this.git(`commit-tree ${tree} -p ${parent} -F ${this.quotePath(tmp)}`, env);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* 同上 */ }
    }
  }

  // ——— 被冻结（skip-worktree / assume-unchanged）文件的合并兜底 ———
  // 列出本机所有被冻结的文件，连同冻结类型。
  //   git ls-files -v 每行 "<T> <path>"：T='S' 是 skip-worktree；T 为小写字母是 assume-unchanged。
  async frozenFiles() {
    const r = await this.git('-c core.quotepath=false ls-files -v');
    if (r.code !== 0) return [];
    const out = [];
    for (const line of r.out.split('\n')) {
      if (line.length < 3 || line[1] !== ' ') continue;
      const tag = line[0];
      const p = line.slice(2);
      if (tag === 'S') out.push({ path: p, kind: 'skip' });
      else if (tag >= 'a' && tag <= 'z') out.push({ path: p, kind: 'assume' });
    }
    return out;
  }

  // 合并前：把"被冻结 且 本次合并要改动"的文件临时解冻并丢弃本机改动，好让合并覆盖过去。
  // 这类文件（Obsidian 的 workspace.json、notebook-navigator/data.json 等）只是本机 UI 状态，
  // 丢掉无所谓；但它们被冻结时 git 会因"local changes would be overwritten"拒绝整个合并。
  // 返回 { files:[{path,kind}] } 供合并后恢复冻结；出错返回 { err }。
  async freeFrozenBlockers(mergeTarget) {
    const frozen = await this.frozenFiles();
    if (!frozen.length) return { files: [] };
    // 本次合并相对 HEAD 会动到哪些文件
    // 同样必须带 --no-renames，理由见 blockingDirtyFiles 里那段注释：开着改名检测时
    // `--name-only` 只给新路径，而合并要动的是被移走的旧路径，漏掉它同样会卡死合并。
    const diff = await this.git(`-c core.quotepath=false diff --no-renames --name-only HEAD ${mergeTarget}`);
    if (diff.code !== 0) return { files: [] };
    const changing = new Set(diff.out.split('\n').map(s => s.trim()).filter(Boolean));
    const hit = frozen.filter(f => changing.has(f.path));
    if (!hit.length) return { files: [] };
    for (const f of hit) {
      const flag = f.kind === 'skip' ? '--no-skip-worktree' : '--no-assume-unchanged';
      let r = await this.git(`update-index ${flag} -- ${this.quotePath(f.path)}`);
      if (r.code !== 0) return { err: `解冻 ${f.path}: ` + (r.err || r.out) };
      // 丢弃本机对该文件的改动（索引里是 HEAD 版，checkout 把工作区拉回与索引一致），
      // 这样合并时它没有"本机改动"挡着，可被正常覆盖。
      r = await this.git(`checkout -- ${this.quotePath(f.path)}`);
      if (r.code !== 0) return { err: `重置 ${f.path}: ` + (r.err || r.out) };
    }
    return { files: hit };
  }

  // 合并后：把上面临时解冻的文件恢复原来的冻结标记，免得它们此后又被当成"改动"冒出来。
  async refreezeFiles(files) {
    for (const f of files) {
      const flag = f.kind === 'skip' ? '--skip-worktree' : '--assume-unchanged';
      await this.git(`update-index ${flag} -- ${this.quotePath(f.path)}`);
    }
  }

  // 本机实际配了哪些远程
  async listRemotes() {
    const r = await this.git('remote');
    if (r.code !== 0) return [];
    return r.out.split('\n').map(s => s.trim()).filter(Boolean);
  }

  // 决定这次同步用哪个远程。规则：
  //   1. 设置里指定了、且本机确实有这个远程 → 直接用；
  //   2. 本机只有一个远程 → 直接用它（设置里填的名字不存在时也走这条，并把设置纠正过来）；
  //   3. 本机有多个远程、又没选对 → 弹窗让人选一次，选完记进设置，以后不再问。
  // 返回 null 表示这次同步应当放弃（没有远程，或人没选）。
  async resolveRemote(manual) {
    const remotes = await this.listRemotes();
    if (!remotes.length) {
      this.notify('这个仓库没有配置任何远程，无法同步', true);
      return null;
    }
    const want = (this.settings.remote || '').trim();
    if (want && remotes.includes(want)) return want;

    if (remotes.length === 1) {
      const only = remotes[0];
      // 只在内存里用，不写回 data.json。data.json 是 git 跟踪的，会跨机同步：
      // 若这里把探测结果存盘，PC 改成 origin 同步给 Mac、Mac 发现不存在又改回 cnb 再同步回来，
      // 两台机器会无休止地来回改这个文件、不断制造冲突。自动探测每次现算即可，代价只有一条
      // `git remote`。只有人明确选过的远程才落盘（见下面的弹窗分支和设置面板）。
      if (want && !this._remoteFallbackNoticed) {
        this._remoteFallbackNoticed = true;
        this.notify(`设置里的远程 "${want}" 在这台机器上不存在；本机只有一个远程 "${only}"，本次起自动改用它`);
      }
      return only;
    }

    // 多个远程：非手动触发时只问一次，避免定时器每隔几分钟就弹一次窗骚扰人
    if (!manual && this._remotePromptDone) {
      this.notify(`本机有多个远程（${remotes.join('、')}），请先在插件设置里选一个`, true);
      return null;
    }
    this._remotePromptDone = true;
    const picked = await this.askRemote(remotes, want);
    if (!picked) {
      this.notify('没有选择远程，本次同步跳过。可随时在插件设置里选', true);
      return null;
    }
    this.settings.remote = picked;
    await this.saveData(this.settings);
    this.notify(`已选定远程 "${picked}"，之后可在设置里更改`);
    return picked;
  }

  askRemote(remotes, invalidName) {
    return new Promise((resolve) => new RemoteChooserModal(this.app, remotes, invalidName, resolve).open());
  }

  async currentBranch() {
    if (this.settings.branch) return this.settings.branch;
    const r = await this.git('rev-parse --abbrev-ref HEAD');
    return r.out || 'master';
  }

  notify(msg, isError) {
    if (isError || this.settings.showNotices) new Notice('[Git Sync] ' + msg);
  }

  // 独立的定时/手动 commit：把工作区当前所有改动打包提交一次，不管是谁改的、改了什么。
  // 跟 pull/push 完全解耦——可以只开这个、关掉 pull/push，反之亦然。
  async doCommit(manual) {
    if (!await this.acquire(LOCK_WAIT_MS)) {
      // 等满了还没轮到：不硬闯（会和前一件事抢同一个仓库），这次安静让过。
      if (manual) this.notify('上一个 git 操作还没做完，请稍后再试', true);
      return;
    }
    this.setStatus('Git Sync: 提交中…');
    try {
      // 必须在 status/add 之前——否则模式位差异会被算成改动、跟着 add -A 一起进提交
      await this.ensureRepoConfig();
      const st = await this.git('status --porcelain');
      if (!st.out) {
        if (manual) this.notify('没有需要提交的改动');
        this.setStatus('Git Sync: 就绪');
        return;
      }
      const blocked = await this.lfsBlocked(await this.dirtyPaths());
      if (blocked) { this.notifyLfsBlocked(blocked, '提交'); this.setStatus('Git Sync: 提交已中止'); return; }
      const addR = await this.git('add -A');
      if (addR.code !== 0) {
        this.notify('提交失败（add）：' + (addR.err || addR.out).split('\n')[0], true);
        this.setStatus('Git Sync: 提交失败');
        return;
      }
      const files = st.out.split('\n').filter(Boolean);
      const listed = files.length <= 20
        ? files.join('\n')
        : files.slice(0, 20).join('\n') + `\n... 共 ${files.length} 项改动，仅列前 20 项`;
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      const message = `vault auto-commit: ${stamp}\n\n${listed}`;
      const r = await this.commitWithMessage(message);
      if (r.code !== 0) {
        this.notify('提交失败：' + (r.err || r.out).split('\n')[0], true);
        this.setStatus('Git Sync: 提交失败');
      } else {
        this.notify(`已提交 ${files.length} 项改动`);
        this.setStatus('Git Sync: 就绪');
      }
    } finally { this.busy = false; }
  }

  async doPull(manual) {
    if (!await this.acquire(LOCK_WAIT_MS)) {
      // 等满了还没轮到：不硬闯（会和前一件事抢同一个仓库），这次安静让过。
      if (manual) this.notify('上一个 git 操作还没做完，请稍后再试', true);
      return;
    }
    this.setStatus('Git Sync: 拉取中…');
    try {
      // 先处理上一轮遗留、卡在半途的合并（MERGE_HEAD 还在）。
      //
      // resolveConflictTwoPhase 失败时会故意"保留现场不动，等人来处理"（见下面的注释），
      // 但本插件是无人值守的定时任务（默认每 10 分钟一次），没有人会去处理——下一轮
      // 直接对一个已经处于合并中途的仓库再跑一次 fetch + merge，checkoutFileFromCommit
      // 虽然每次都会把文件整份替换成干净版本，但如果上一轮的合并根本没走到那一步就卡住
      // （比如中途被别的进程/人工命令打断），working tree 里可能还留着上一轮 git merge
      // 自己写的原始 <<<<<<< 标记；这一轮的 fetch+merge 会在这份已经带标记的工作区上
      // 再冲突一次，把新的一层标记叠在旧的上面——2026-09-04 实测被叠加到 9~15 层
      // （3 篇笔记 + 1 个体检趋势 json）。所以每次 doPull 一开始，先检查有没有遗留的
      // MERGE_HEAD，有就用同一套两阶段逻辑把它续完；续不完（比如连冲突文件都读不到）
      // 就彻底 abort，交给本轮重新 fetch+merge，绝不放着让下一轮继续往上叠。
      const staleMerge = (await this.git('rev-parse --verify --quiet MERGE_HEAD')).out;
      if (staleMerge) {
        const staleConflicted = await this.git('-c core.quotepath=false diff --name-only --diff-filter=U');
        const staleFiles = this.gitPathLines(staleConflicted.out);
        let recovered = false;
        if (staleFiles.length) {
          this.notify(`发现上一轮遗留的未完成合并（${staleFiles.length} 个冲突文件），先续完它，不会在此基础上再叠加标记`, true);
          recovered = await this.resolveConflictTwoPhase(staleFiles, 'MERGE_HEAD');
        }
        if (!recovered) {
          await this.git('merge --abort');
          this.notify('上一轮遗留的合并已放弃（abort），本轮改为重新 fetch + merge，避免标记继续叠加', true);
        } else {
          this.notify('上一轮遗留的未完成合并已续完解决');
        }
      }

      // pull 路径也可能提交（挡路文件、冲突两阶段），同样先校准模式位再判断工作区脏不脏
      await this.ensureRepoConfig();
      const remote = await this.resolveRemote(manual);
      if (!remote) { this.setStatus('Git Sync: 未选定远程'); return; }
      const branch = await this.currentBranch();
      const fetchR = await this.gitNet(`fetch ${remote} ${branch}`);
      if (fetchR.code !== 0) {
        const first = (fetchR.err || fetchR.out).split('\n')[0] || '未知错误';
        // 网络不通要和普通 fetch 失败分开报，否则人只看到"拉取失败"，会先去翻仓库，
        // 而真正该看的是远程服务还活着没有。
        if (fetchR.netDown) this.reportNetDown('拉取', first);
        else {
          this.notify('拉取失败（fetch）：' + first, true);
          this.setStatus('Git Sync: 拉取失败');
        }
        return;
      }
      const remoteRef = `${remote}/${branch}`;

      // 先刷掉"幻影修改"：内容没变、只是 index 的 stat 缓存对不上的文件。
      // 必须排在挡路检测之前——挡路检测按内容比对，压根看不见这类文件，
      // 不先刷掉它们，下面所有的兜底逻辑都会一路放行，然后死在 merge 那一步。
      await this.refreshPhantomDirty();

      // 合并前先处理"挡路文件"。git 因工作区有改动而拒绝合并时不产生任何冲突文件，
      // 下面那套两阶段冲突处理完全不会被触发，只会报一句语焉不详的失败然后卡死在这里。
      const blockers = await this.blockingDirtyFiles(remoteRef);
      if (blockers.length) {
        if (!this.settings.commitBlockersBeforePull) {
          const shown = blockers.slice(0, 5).join('\n') + (blockers.length > 5 ? `\n…共 ${blockers.length} 个` : '');
          this.notify('这些文件本机改过、远程这次也改了，git 不允许直接合并。请先提交或撤销它们：\n' + shown, true);
          this.setStatus('Git Sync: 拉取已跳过');
          return;
        }
        if (!await this.commitBlockers(blockers)) {
          this.setStatus('Git Sync: 拉取失败');
          return;
        }
      }

      // Windows 非法文件名兜底：远程若带着含 : * ? " < > | 的文件名（Mac/Linux 合法、
      // Windows 上 NTFS 根本创建不了），git 一 checkout 到它就报 invalid path、整个合并中止，
      // 且不产生冲突文件——同步会永久卡死在这，报错还语焉不详。
      // 这里在合并前先把远程树里的非法名改成全角等价字符（: → ：等），生成一个"消毒过"的提交
      // 顶在远程之上，然后合并这个提交而不是原始远程。全程走临时索引，那个非法名一次都不落到
      // 工作区，所以在 Windows 上也能安全操作。改名会随后续 push 传回远程，别的机器也一起修好。
      let mergeTarget = remoteRef;
      const sanitized = await this.sanitizeIncomingIfNeeded(remoteRef);
      if (sanitized && sanitized.err) {
        this.notify('拉取失败（非法文件名兜底出错）：' + sanitized.err.split('\n')[0], true);
        this.setStatus('Git Sync: 拉取失败');
        return;
      }
      if (sanitized && sanitized.commit) {
        mergeTarget = sanitized.commit;
        const shown = sanitized.renames.slice(0, 5).map(r => `${r.from}\n  → ${r.to}`).join('\n');
        this.notify(
          `远程有 ${sanitized.renames.length} 个 Windows 非法文件名，已自动改用全角字符改名后再合并：\n` +
          shown +
          `\n注意：改名可能使指向它的 [[双链]] 失效，建议之后在 Mac 上用 obsidian-cli 规范改名并修复反链。`,
          true
        );
      }

      // skip-worktree / assume-unchanged 文件兜底：Obsidian 的每机状态文件
      // （workspace.json、notebook-navigator/data.json 等）常被 git 标成 skip-worktree 冻结，
      // 但一旦远程也改了同一个文件，git 会拒绝合并（"local changes would be overwritten"），
      // 且不产生冲突文件——而这类文件 git diff 又不报，前面的挡路检测看不见它们，合并就永久卡死。
      // 这里在合并前找出"被冻结 且 本次合并要改动"的文件，把本机那份丢弃（它们只是本机 UI 状态，
      // 丢掉无所谓），让合并能覆盖过去；合并完再把冻结标记恢复原样。
      const freed = await this.freeFrozenBlockers(mergeTarget);
      if (freed && freed.err) {
        this.notify('拉取失败（处理冻结文件出错）：' + freed.err.split('\n')[0], true);
        this.setStatus('Git Sync: 拉取失败');
        return;
      }

      // LFS 对象损坏兜底（2026-08-11 用户定："坏了就删，同步是第一要务"）。
      //
      // 服务端存的某个 LFS 对象一旦损坏（下载下来的内容 sha256 对不上 oid），smudge 过滤器
      // 就会失败、整个 merge 中止，而且**不产生任何冲突文件**——下面那套两阶段冲突处理
      // 根本不会被触发，只会报一句语焉不详的失败。更糟的是下一轮同步会把半更新的工作区
      // 当成"挡路文件"提交一版，于是 10 分钟一个垃圾提交、无限循环
      // （2026-08-11 实测 4.5 小时连续堆出 84 个「同步前自动保存」提交，并差点把它们推上远程）。
      //
      // 处理原则：**同步优先于内容完整性**。一旦识别出是 LFS smudge 失败，就关掉 LFS 过滤器
      // 重试合并——LFS 文件先按 133 字节的指针落盘，合并一定能走完，同步不再被任何坏对象挡住。
      // 内容随后由 purgeBrokenLfs() 补：能补回来的补回来，确实取不回来的直接删掉。
      let merge = await this.git(`merge --no-edit ${mergeTarget}`);
      let lfsFallback = false;
      if (merge.code !== 0 && this.isLfsSmudgeFailure(merge)) {
        await this.git('merge --abort'); // 没开始的合并 abort 会报错，忽略即可
        lfsFallback = true;
        this.notify('有 LFS 对象取不回来，已改用「先落指针、事后补内容」的方式继续合并，同步不中断', true);
        merge = await this.git(`${LFS_OFF} merge --no-edit ${mergeTarget}`);
      }
      // 无论合并成败，先把上面临时解冻的文件恢复冻结，避免它们此后又冒出来当"改动"
      if (freed && freed.files && freed.files.length) await this.refreezeFiles(freed.files);
      if (merge.code === 0) {
        if (/up to date|already up to date|已经是最新/i.test(merge.out)) {
          this._pullUpToDate = true; // 这轮没拉到新东西，供 runSync 判断是否收敛
          if (manual) this.notify('已是最新');
        } else {
          this.notify('已从 ' + remote + ' 拉取合并');
        }
        if (lfsFallback) await this.purgeBrokenLfs();
        this.setStatus('Git Sync: 就绪');
        return;
      }

      // merge 失败：先分清是不是真正的内容冲突，不是的话（网络、鉴权等）按老逻辑上报并中止，别留半吊子状态。
      // 必须带 core.quotepath=false，否则中文文件名会被八进制转义+加引号，后续 checkout/stage 全对不上路径。
      let conflicted = await this.git('-c core.quotepath=false diff --name-only --diff-filter=U');
      let files = this.gitPathLines(conflicted.out);
      if (!files.length) {
        // 不是内容冲突，git 在动手前就直接拒绝了。最常见的一种是
        // "Your local changes to the following files would be overwritten by merge"——
        // 这条错误里 git 自己把挡路的文件名一行行列了出来，比 blockingDirtyFiles() 预先
        // 算好的那份挡路清单更权威、更即时。
        // 2026-09-04 实测：预先算出的挡路文件被 commitBlockers 提交之后，紧接着的这次
        // merge 依然报同一批文件挡路（具体是哪个环节让它们在提交后又变脏，没能查清楚——
        // 但不管原因是什么，git 报错里点的名字永远是它这一刻的真实判断）。与其原地放弃、
        // 把"冲突未解决"的半吊子状态留给下一个 10 分钟周期去叠加，不如照着 git 报错点的
        // 名字再保存一次、重试一次合并——只重试这一次，不无限循环。
        const overwritten = this.parseOverwrittenFiles(
          ((merge && merge.err) || '') + '\n' + ((merge && merge.out) || '')
        );
        if (overwritten.length) {
          this.notify(`合并被 ${overwritten.length} 个文件挡住（不是内容冲突）：${overwritten.slice(0, 3).join('、')}${overwritten.length > 3 ? ' 等' : ''}，按 git 报错点的名字重新保存一次再重试`, true);
          if (!await this.commitBlockers(overwritten)) {
            this.setStatus('Git Sync: 拉取失败');
            return;
          }
          merge = await this.git(`${lfsFallback ? LFS_OFF + ' ' : ''}merge --no-edit ${mergeTarget}`);
          if (merge.code === 0) {
            this.notify('已从 ' + remote + ' 拉取合并（重试后成功）');
            if (lfsFallback) await this.purgeBrokenLfs();
            this.setStatus('Git Sync: 就绪');
            return;
          }
          conflicted = await this.git('-c core.quotepath=false diff --name-only --diff-filter=U');
          files = this.gitPathLines(conflicted.out);
        }
      }
      if (!files.length) {
        // 合并可能压根没开始（网络、鉴权等），这时 --abort 自己会报错；忽略即可，
        // 没开始的合并本来也不需要中止。
        await this.git('merge --abort');
        this.notify('拉取失败：' + this.errLine(merge), true);
        this.setStatus('Git Sync: 拉取失败');
        return;
      }

      // 真正冲突：两阶段提交解决（设计见 冲突合并设计.md）。
      // 用 mergeTarget（可能是消毒过的提交）而非原始 remoteRef，冲突取舍的时间戳才对得上。
      if (!await this.resolveConflictTwoPhase(files, mergeTarget)) {
        // 冲突处理中途放弃（LFS 挡下、或仍有未解决的冲突）。保留现场不动，等人来处理——
        // 这里绝不能继续提交，否则就会把带冲突标记的文件写进历史。
        this.setStatus('Git Sync: 冲突未解决');
        return;
      }
      this.notify(`拉取遇到冲突（${files.length} 个文件），已按时间顺序分两次提交解决，详见 git log`, true);
      if (lfsFallback) await this.purgeBrokenLfs();
      this.setStatus('Git Sync: 就绪');
    } finally { this.busy = false; }
  }

  // 这次 git 失败是不是"LFS 内容取不回来"引起的？
  // 典型输出（三种都见过，所以三种都认）：
  //   Smudge error: ... expected OID <a>, got <b> after N bytes written   ← 服务端对象损坏
  //   error: external filter '/path/to/git-lfs filter-process' failed     ← 过滤器整体挂掉
  //   fatal: <文件>: smudge filter lfs failed
  isLfsSmudgeFailure(r) {
    const t = ((r && r.err) || '') + '\n' + ((r && r.out) || '');
    return /smudge filter lfs failed|Smudge error|expected OID|external filter .*git-lfs.* failed/i.test(t);
  }

  // 工作区里"还只是 LFS 指针、真实内容没落地"的文件。
  // git lfs checkout 会把已下载的对象写成真实文件，没下载的就报 Skipped 并点名，正好拿来当清单。
  async missingLfsFiles() {
    const r = await this.gitLong(`-c core.quotepath=false lfs checkout`);
    const text = (r.out || '') + '\n' + (r.err || '');
    const re = /Skipped checkout for "([^"]+)", content not local/g;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return [...new Set(out)];
  }

  // 「坏了就删」（2026-08-11 用户定）。合并已经在上一步用关掉过滤器的方式走完了，
  // 所以**同步此刻已经不被任何东西挡住**，这里纯粹是事后补内容 + 清理，可以从容判断：
  //   - 补得回来的         → 补回来，什么也不删；
  //   - 服务端对象损坏/已不存在 → 内容永远回不来了。留着 133 字节的指针存根毫无用处，
  //                          反而让每台机器每次 checkout/merge 都在同一处炸掉 → 直接删。
  //   - 疑似纯网络问题     → 下次还能拉回来 → 只报告，不删（宁可少删）。
  // 判据取自 git lfs fetch 的报错原文：出现 expected OID / 404 / NoSuchKey 之类才算"确实坏了"。
  async purgeBrokenLfs() {
    await this.gitLong('lfs fetch');
    let broken = await this.missingLfsFiles();
    if (!broken.length) return [];

    // 再拉一次，排除偶发网络抖动造成的误判
    const retry = await this.gitLong('lfs fetch');
    broken = await this.missingLfsFiles();
    if (!broken.length) return [];

    const evidence = ((retry.err || '') + '\n' + (retry.out || ''));
    if (!/expected OID|404|Not Found|NoSuchKey|does not exist|missing object|object not found/i.test(evidence)) {
      this.notify(
        `有 ${broken.length} 个 LFS 文件这次没取回来，报错不像是"对象损坏"（更像网络问题），已保留、未删除：\n`
        + broken.slice(0, 5).join('\n') + (broken.length > 5 ? `\n…共 ${broken.length} 个` : ''),
        true
      );
      return [];
    }

    for (const f of broken) {
      const r = await this.git(`rm -f -- ${this.quotePath(f)}`);
      if (r.code !== 0) {
        this.notify(`删除损坏 LFS 文件失败（${f}）：` + (r.err || r.out).split('\n')[0], true);
        return [];
      }
    }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const message =
      `同步前自动删除损坏的 LFS 文件：${broken.length} 个\n`
      + '\n'
      + '为什么会有这次提交\n'
      + '  下面这些文件归 Git LFS 管，但它们的内容对象在远程服务端已经损坏或不存在——\n'
      + '  下载回来的字节校验不过（expected OID … got …），任何机器都取不回原始内容。\n'
      + '  工作区里它们只是 133 字节左右的指针存根，不是可用的图片/文档。\n'
      + '\n'
      + '为什么直接删掉\n'
      + '  留着指针存根不会让内容回来，只会让每台机器每次 checkout / merge 都在同一处失败，\n'
      + '  把整条同步链路卡死（2026-08-11 曾因此 4.5 小时内堆出 84 个垃圾提交）。\n'
      + '  按"坏了就删、同步优先"的既定原则，这里直接把它们从分支尖端删除。\n'
      + '\n'
      + '想找回内容怎么办\n'
      + '  文件名和 oid 仍完整保留在 git 历史里，可用 `git log --all -- <路径>` 查到。\n'
      + '  真要恢复，只能在还留有原始文件的机器或原始归档里重新上传一份正确的对象。\n'
      + '\n'
      + `被删除的 ${broken.length} 个文件：\n`
      + broken.map(f => '  - ' + f).join('\n')
      + '\n\n'
      + `时间：${stamp}\n`;
    const c = await this.commitWithMessage(message);
    if (c.code !== 0) {
      this.notify('删除损坏 LFS 文件后提交失败：' + (c.err || c.out).split('\n')[0], true);
      return [];
    }
    this.notify(`有 ${broken.length} 个 LFS 文件在服务端已损坏、取不回来，已按"坏了就删"原则删除并提交`, true);
    return broken;
  }

  // 分支尖端永远不留两个连续的自动提交（2026-08-11 用户定）。
  //
  // 插件在"合并被挡住"和"有冲突"时都会自己提交一版让流程能继续走。同一个障碍反复出现时，
  // 这类提交就会一条接一条堆在尖端，把真正的历史彻底淹没——2026-08-11 连续堆了 84 个
  // 「同步前自动保存：8 个文件挡住了本次合并」，人再也看不出这段时间到底发生过什么。
  //
  // 所以每次推送前先折叠：**只动"还没推出去的、位于尖端的、连续的自动提交"**，
  // 一个都不多碰。已经推出去的、人写的、合并提交，全部原样保留。
  async squashAutoCommits(remote, branch) {
    if ((await this.git('rev-parse --verify --quiet MERGE_HEAD')).out) return 0; // 合并进行中，不动
    const upstream = `${remote}/${branch}`;
    if (!(await this.git(`rev-parse --verify --quiet ${upstream}`)).out) return 0;
    const list = await this.git(`log --format=%H%x1f%P%x1f%s ${upstream}..HEAD`);
    if (!list.out) return 0;

    const rows = list.out.split('\n').filter(Boolean).map(l => l.split('\x1f'));
    let k = 0;
    for (const [, parents, subject] of rows) {           // git log 从尖端往回数
      if ((parents || '').trim().split(/\s+/).length !== 1) break; // 合并提交折不了，遇到就停
      if (!AUTO_COMMIT_SUBJECT.test(subject || '')) break;         // 遇到人写的提交立即停
      k++;
    }
    if (k < 2) return 0;                                  // 只有 1 个自动提交是允许的，不折叠

    const reset = await this.git(`reset --soft HEAD~${k}`);
    if (reset.code !== 0) {
      this.notify('折叠自动提交失败（reset）：' + (reset.err || reset.out).split('\n')[0], true);
      return 0;
    }
    // 折叠后可能净变化为零（这些提交互相抵消了），那就什么都不用提交，白堆的 k 个提交直接消失
    if (!(await this.git('diff --cached --name-only')).out) {
      this.notify(`已折叠掉尖端 ${k} 个互相抵消的自动提交（净变化为零，未产生新提交）`);
      return k;
    }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const message =
      `同步自动提交合并：把尖端 ${k} 个自动提交折叠成 1 个\n`
      + '\n'
      + '为什么会有这次提交\n'
      + '  Simple Git Sync 在"合并被挡住"或"有冲突"时会自己提交一版，让同步流程能继续走下去。\n'
      + '  同一个障碍反复出现时，这类提交会一条接一条堆在分支尖端，把真正的历史淹没\n'
      + '  （2026-08-11 曾在 4.5 小时里连续堆出 84 个）。\n'
      + '  因此插件规定：分支尖端永远不出现两个连续的自动提交，推送前一律折叠成一个。\n'
      + '\n'
      + '这次折叠动了什么\n'
      + '  只折叠"尚未推送 + 位于尖端 + 连续"的自动提交，内容一字未改（git reset --soft 后重提）。\n'
      + '  已推送的提交、人写的提交、合并提交一律原样保留，遇到就立即停止折叠。\n'
      + `  想看被折叠掉的每一步：git reflog 里仍可查到折叠前的 ${k} 个提交。\n`
      + '\n'
      + `被折叠的 ${k} 个提交（新 → 旧）：\n`
      + rows.slice(0, k).map(r => '  - ' + r[2]).join('\n')
      + '\n\n'
      + `时间：${stamp}\n`;
    const c = await this.commitWithMessage(message);
    if (c.code !== 0) {
      this.notify('折叠自动提交失败（commit）：' + (c.err || c.out).split('\n')[0], true);
      return 0;
    }
    this.notify(`已把尖端 ${k} 个自动提交折叠成 1 个，历史不再被刷屏`);
    return k;
  }

  // 挡路文件 = （工作区改过的） ∩ （这次合并要写入的）。
  // git 只在这两个集合有交集时才拒绝合并；工作区里其它没写完的改动跟本次合并无关，
  // 合并根本不会碰它们，也就不该被牵连着提交进历史——这是这里不用 `add -A` 的原因。
  //
  // 为什么不用 stash：stash 会把工作区文件回退成 HEAD 版本，而 Obsidian 很可能正开着
  // 其中某个笔记；编辑器发现文件在背后被改写，可能把旧内容再写回去，反而丢掉正在写的东西。
  // commit 完全不动工作区内容，对一个开着编辑器的笔记库安全得多。
  // 工作区里所有有改动的路径（已跟踪的改动 + 未被忽略的未跟踪文件）。
  // core.quotepath=false：默认设置下中文路径会被转义成 \350\260\203… 的形式，路径就对不上了。
  // 本库碰巧配过 false，但别的机器上新克隆出来的没有，所以每条命令都自带该参数。
  // git 打印路径时的 C 风格引号解码。
  //
  // ⚠️ core.quotepath=false **只管非 ASCII**。名字里只要有 " 或 \，git 一律把整条路径
  // 用双引号包起来并把 \ 转义成 \\，跟 quotepath 无关、关不掉。不解码就会拿着一个
  // 带引号、带双反斜杠的**假路径**去 fs.rename / git add。
  //
  // 2026-08-25 实测（同步连续中止的直接原因）：库根有个文件真名叫
  //   D：\VerySync\VerySync_notes\0-System\tmp\orphan-tags.yaml
  // （Windows 那边一条命令把整条路径当成了文件名带进库），`git ls-files` 输出成
  //   "D：\\VerySync\\…\\orphan-tags.yaml"
  // 于是 localIllegalNames() 把 **git 自己加的那两个引号**当成 Windows 非法字符，
  // 要给一个根本不存在的路径改名 → ENOENT → sanitizeLocalNames 返回 false →
  // 整轮同步中止，每 10 分钟重来一次。
  // （更讽刺的是这个文件本身就是消毒逻辑上一次改名提交进来的：1e238cb05
  //   「同步前置：修正 1 个跨平台非法文件名」——消毒器造出了卡死消毒器的文件。）
  unquoteGitPath(p) {
    const s = String(p);
    if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
    const body = s.slice(1, -1);
    const esc = { n: '\n', t: '\t', r: '\r', f: '\f', b: '\b', v: '\v', a: '\x07', '\\': '\\', '"': '"' };
    let out = '', i = 0;
    while (i < body.length) {
      if (body[i] !== '\\') { out += body[i]; i++; continue; }
      const n = body[i + 1];
      if (n === undefined) { out += body[i]; break; }
      if (n >= '0' && n <= '7') {
        // \nnn 是 UTF-8 的**字节**，必须整段收齐再一起解码，逐个转会把中文拆碎
        const bytes = [];
        while (body[i] === '\\' && /[0-7]/.test(body[i + 1] || '')) {
          bytes.push(parseInt(body.substr(i + 1, 3), 8));
          i += 4;
        }
        out += Buffer.from(bytes).toString('utf8');
        continue;
      }
      out += (esc[n] !== undefined ? esc[n] : n);
      i += 2;
    }
    return out;
  }

  // 把 git 的「一行一个路径」输出切成真实路径数组（顺带解码引号）。
  // ⚠️ 只用于换行分隔的输出；-z（NUL 分隔）的输出 git 从不加引号，那种不能解码，
  // 否则真名以引号开头结尾的文件会被削掉引号。
  gitPathLines(out) {
    return String(out || '').split('\n').map(s => s.trim()).filter(Boolean)
      .map(s => this.unquoteGitPath(s));
  }

  // 从 "Your local changes to the following files would be overwritten by merge/checkout:"
  // 这类 git 报错文本里，把它点名的文件路径一行行抠出来。
  // 这份名单比任何预先算好的挡路清单都权威——它是 git 在真正动手那一刻的判断，
  // 不管是 blockingDirtyFiles() 漏算了什么、还是文件在提交后又不知为何变脏，
  // 这里都能兜住，因为兜的是 git 自己报出来的事实，不是我们对它的预测。
  parseOverwrittenFiles(text) {
    const lines = String(text || '').split('\n');
    const startIdx = lines.findIndex(l => /would be overwritten by (merge|checkout)/i.test(l));
    if (startIdx === -1) return [];
    const out = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) break;
      if (/^(please|aborting|error|fatal)\b/i.test(raw.trim())) break;
      out.push(this.unquoteGitPath(raw.trim()));
    }
    return out;
  }

  async dirtyPaths() {
    const changed = await this.git('-c core.quotepath=false diff --name-only HEAD');
    const untracked = await this.git('-c core.quotepath=false ls-files --others --exclude-standard');
    return [...new Set(this.gitPathLines(changed.out).concat(this.gitPathLines(untracked.out)))];
  }

  // 幻影修改兜底：index 的 stat 缓存跟磁盘对不上，但文件内容其实一个字节都没变。
  //
  // 这是 freeFrozenBlockers() 那一类问题的又一个变种，也是本插件遇到过的第三种
  // "git 拒绝合并、却不产生任何冲突文件、而挡路检测又看不见它"的情形：
  //   dirtyPaths() 用的是 git diff --name-only HEAD，那是**按内容**比对；
  //   而 git 决定"合并会不会覆盖你的本地改动"用的是**按 stat**比对。
  //   幻影文件恰好卡在两者中间：stat 说变了、内容说没变。
  //   于是 blockingDirtyFiles() 返回空 → 不预提交 → merge 立刻报
  //   "Your local changes to the following files would be overwritten by merge" → 同步永久卡死，
  //   而且报错点名的是一个用户根本没动过的文件，谁看了都会往错的方向排查。
  //
  // 沙箱实测（2026-08-20，autocrlf=true 下检出后用 LF 版覆盖，模拟 VerySync 盖回来）：
  //   git status --porcelain     → " M f.md"     ← 看得见
  //   git diff --name-only       → 空            ← 瞎
  //   git diff --name-only HEAD  → 空            ← 瞎（dirtyPaths 用的就是这条）
  //   git diff-files --name-only → f.md          ← 看得见
  //   直接 merge → 报 "would be overwritten by merge"，与线上症状一字不差。
  //
  // 处置：对每个 stat 脏但内容不脏的文件跑一次 git add。因为内容与 index 里的 blob 完全相同，
  // 这次 add **不会往暂存区放进任何东西**（沙箱验证 git diff --cached --name-only 为空），
  // 纯粹是让 git 把 stat 缓存刷新成磁盘的真实状态。不写盘、不碰文件内容、不产生提交。
  //
  // 为什么不用 git checkout -- <file>：能清掉，但会覆写工作区。这个库随时可能有 Obsidian
  // 开着某篇笔记、VerySync 正在往里写，多一次抢写就多一次风险；既然字节已经一样，没有覆写的理由。
  // 为什么不用 stash / reset：理由同 commitBlockers 那节——不能动别人还没写完的东西。
  //
  // 判据故意用"逐个核对 hash"而不是"diff-files 减去 diff"的集合差：多花几条命令，
  // 换的是"绝不会把一个真实改动误当幻影 add 进去"。候选文件通常只有几个，代价可以忽略。
  async refreshPhantomDirty() {
    const r = await this.git('-c core.quotepath=false diff-files --name-only');
    if (r.code !== 0) return [];
    const candidates = this.gitPathLines(r.out);
    if (!candidates.length) return [];

    const phantoms = [];
    for (const f of candidates) {
      // 工作区文件已被删除时 hash-object 会失败，自然落不进 phantoms（那是真删除，不该碰）
      const wh = await this.git(`hash-object -- ${this.quotePath(f)}`);
      if (wh.code !== 0 || !wh.out) continue;
      const idx = await this.git(`ls-files -s -- ${this.quotePath(f)}`);
      const ih = (idx.out.split(/\s+/)[1] || '');
      if (ih && ih === wh.out) phantoms.push(f);
    }
    if (!phantoms.length) return [];

    // 没装 git-lfs 时不碰 LFS 管的文件，理由同 commitBlockers：宁可这次不动，也不能弄坏仓库。
    // （实际上 LFS 文件几乎不可能被判成幻影——过滤器缺失时 hash 根本对不上——这里只是兜底。）
    const blocked = await this.lfsBlocked(phantoms);
    const safe = blocked ? phantoms.filter(f => !blocked.includes(f)) : phantoms;
    if (!safe.length) return [];

    const done = [];
    for (const f of safe) {
      if ((await this.git(`add -- ${this.quotePath(f)}`)).code === 0) done.push(f);
    }
    if (done.length) {
      const shown = done.slice(0, 5).join('\n') + (done.length > 5 ? `\n…共 ${done.length} 个` : '');
      this.notify(
        `已刷新 ${done.length} 个"幻影修改"的索引状态（内容与库里完全相同，只是 git 的 stat 缓存对不上）：\n` +
        shown + '\n没有产生任何提交，工作区内容一个字节都没动。'
      );
    }
    return done;
  }

  // 本机有没有 git-lfs（结果缓存，一次会话只探一次）
  async lfsAvailable() {
    if (this._lfsOk === undefined) this._lfsOk = (await this.git('lfs version')).code === 0;
    return this._lfsOk;
  }

  // 这批路径里有没有归 LFS 管、而本机又没装 git-lfs 的。
  // 没装 git-lfs 却提交 LFS 管的文件，会把大文件原样写进版本库并破坏 LFS 指针，
  // 事后很难收拾（本库 2026-07-25 的 a9a8aeb 就是这么坏的）。宁可这次不提交，也不能弄坏仓库。
  // 返回被挡下的文件名数组；没问题则返回 null。
  async lfsBlocked(files) {
    if (!files || !files.length) return null;
    if (await this.lfsAvailable()) return null;
    const managed = [];
    for (const f of files) {
      const r = await this.git(`check-attr filter -- ${this.quotePath(f)}`);
      if (/:\s*filter:\s*lfs\s*$/m.test(r.out)) managed.push(f);
    }
    return managed.length ? managed : null;
  }

  notifyLfsBlocked(managed, what) {
    const shown = managed.slice(0, 5).join('\n') + (managed.length > 5 ? `\n…共 ${managed.length} 个` : '');
    this.notify(
      `${what}已中止：本机没有 git-lfs，而下列文件归 LFS 管。\n` +
      `强行提交会破坏 LFS 指针、把大文件写进版本库。请先装 git-lfs，或在装有 git-lfs 的机器上提交：\n` + shown,
      true
    );
  }

  async blockingDirtyFiles(remoteRef) {
    const dirty = new Set(await this.dirtyPaths());
    if (!dirty.size) return [];
    // 三点差分：只列远程侧自分叉点以来动过的文件，也就是这次合并真正会写入工作区的那批。
    //
    // ⚠️ 必须带 --no-renames。git 默认开启改名检测，一旦远程把某文件从 A 移到 B，
    // `--name-only` 只打印新路径 B，旧路径 A 根本不出现——可合并要做的恰恰是把 A 从
    // 工作区**删掉**。于是本机改过 A 时，A 不在这份清单里 → 不判为挡路 → 不预提交 →
    // 合并立刻以 "Your local changes to the following files would be overwritten by merge: A"
    // 失败，且不产生冲突文件，同步永久卡死，报错还只提一个看不出所以然的文件名。
    // 2026-08-13 实测：远程把 `5-Publish/5A-正在写/无感FOC….md` 移到 `5D-已完成/`（R096），
    // 本机那份有 136 行未提交改动，同步连续四个多小时轮轮失败，根因就是这一条。
    const incoming = await this.git(`-c core.quotepath=false diff --no-renames --name-only HEAD...${remoteRef}`);
    if (incoming.code !== 0) return [];
    const blockers = this.gitPathLines(incoming.out).filter(f => dirty.has(f));

    // 第四种"git 拒绝合并、却不产生任何冲突文件、而挡路检测又看不见它"的情形：**索引不干净**。
    //
    // 真合并（非快进）要求索引与 HEAD 完全一致，**哪怕那个文件这次合并根本不会碰**。
    // 上面那份清单是"远程也动过的"交集，只暂存在本机、远程压根没有的文件不在里面，于是：
    //   不判为挡路 → 不预提交 → merge 立刻报
    //   "Your local changes to the following files would be overwritten by merge: <某文件>"
    //   → 同步永久卡死，而且点名的是一个跟这次合并毫无关系的文件，谁看了都会往错的方向排查。
    //
    // 沙箱实测（2026-08-24）：远程改 a.md，本机另有一次提交（真分叉），索引里只多暂存了一个
    // 远程根本没有的新文件 z.md → merge 直接失败并点名 z.md；把 z.md 一起提交后合并立刻通过。
    // 快进合并没有这个限制（只有被合并覆盖的那几个文件要干净），所以只在非快进时才补这一批。
    //
    // 为什么这一类在本库是常态而不是意外：CLAUDE.md 要求 agent「每改一个文件立刻 git add 那个
    // 文件（只暂存不提交）」，好让并发写入不被别人静默还原。索引因此长期非空，
    // 这条兜底不补，本库的同步迟早会卡死。
    const ff = await this.git(`merge-base --is-ancestor HEAD ${remoteRef}`);
    if (ff.code !== 0) {   // 非快进（或判不出来）→ 一律按"索引必须干净"处理
      const staged = await this.git('-c core.quotepath=false diff --cached --name-only HEAD');
      if (staged.code === 0) {
        for (const f of this.gitPathLines(staged.out)) {
          if (!blockers.includes(f)) blockers.push(f);
        }
      }
    }
    return blockers;
  }

  // 从命令输出里挑出真正说明问题的那一行。
  //
  // 直接取第一行会被"表头"骗过去：commit-msg 钩子跑的 commit_sanity.py，输出第一行是
  // `── 暂存区`，于是弹窗显示"拉取失败：── 暂存区"，等于什么都没说，
  // 真正的原因（🔴 S3 实际改动 36 个文件…）在第四行（2026-08-25 实测，为这一行找了很久）。
  errLine(r) {
    const lines = (((r && r.err) || '') + '\n' + ((r && r.out) || ''))
      .split('\n').map(s => s.trim()).filter(Boolean);
    const hit = lines.find(l => /^(error|fatal)\b|⛔|🔴|hook|refus|denied|declin/i.test(l));
    return hit || lines[0] || '(命令没有任何输出)';
  }

  // 路径既不在索引里、也不在工作区里 —— 对它做 git add 只会报
  // "pathspec ... did not match any files"（外加一句 could not open directory 的 warning）。
  // 出现的场景：这条**删除早已暂存好**，连带它所在的目录也一并没了。
  async pathGone(f) {
    const inIndex = (await this.git(`ls-files -- ${this.quotePath(f)}`)).out;
    if (inIndex) return false;
    return !fs.existsSync(path.join(this.vaultPath(), f));
  }

  // 只提交挡路的这几个文件，逐个精确暂存。成功返回 true。
  async commitBlockers(files) {
    const blocked = await this.lfsBlocked(files);
    if (blocked) { this.notifyLfsBlocked(blocked, '同步前保存'); return false; }

    // 已经带着 <<<<<<< / ======= / >>>>>>> 标记、本身就没解决完的文件，绝不能当"当前状态"
    // 原样提交进历史——这一版commit之后可能被 resolveConflictTwoPhase 按提交时间戳选成
    // "较晚/胜出"的一侧（它只比时间先后，不检查内容干不干净），一旦被选中就等于把这份
    // 带标记的垃圾正式定成了最终内容。2026-09-04 实测：同一批文件（3 篇笔记 + 1 个
    // 体检趋势 json）被这样反复"救活"了四轮，每轮人工清理干净后，下一轮同步又把它们
    // 已经脏掉的当前状态当正常改动提交一次，标记就这样重新长回历史里。
    // 遇到就把这些文件从本次要提交的清单里摘掉，只提交其余干净的文件；被摘掉的继续
    // 留在工作区里保持"脏"状态，逼下一轮同步或人正视它、手工解决，而不是被悄悄按下不表。
    const poisoned = [];
    const clean = [];
    for (const f of files) {
      if (await this.pathGone(f)) { clean.push(f); continue; }
      let content = '';
      try { content = fs.readFileSync(path.join(this.vaultPath(), f), 'utf8'); }
      catch (e) { /* 读不到就当干净处理，交给后面正常流程去报错 */ }
      if (/^<<<<<<< |^=======$|^>>>>>>> /m.test(content)) poisoned.push(f);
      else clean.push(f);
    }
    if (poisoned.length) {
      this.notify(
        `发现 ${poisoned.length} 个文件当前内容里还带着未解决的冲突标记，本次跳过、不会当正常内容提交` +
        `（否则可能被后续逻辑误判成"较新版本"永久定下来）：\n` +
        poisoned.slice(0, 5).join('\n') + (poisoned.length > 5 ? `\n…共 ${poisoned.length} 个` : '') +
        '\n请手工打开这些文件解决冲突。',
        true
      );
    }
    if (!clean.length) return false; // 全都是脏的，这次提交做不了任何事，直接报失败，不硬提交
    files = clean;

    for (const f of files) {
      // 删除已经暂存好、连目录都没了的路径：再 add 一次必然失败，
      //   warning: could not open directory '<目录>/': No such file or directory
      //   fatal: pathspec '<路径>' did not match any files
      // 于是"同步前保存"整个中止、同步每 10 分钟失败一次、永久卡死
      // （2026-08-24 线上实测：0-System/archive/ 整个目录被删并已暂存，102 条删除全中）。
      // 这种情况无事可做——删除本身已经在索引里，后面那次 commit 会照常带上它。
      // stageResolved() 里挡的是同一类问题的另一条触发路径（那边是 checkoutFileFromCommit 走了 git rm）。
      if (await this.pathGone(f)) continue;
      const r = await this.git(`add -A -- ${this.quotePath(f)}`);
      if (r.code !== 0) {
        this.notify('同步前保存失败（add ' + f + '）：' + (r.err || r.out).split('\n')[0], true);
        return false;
      }
    }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    // message 要能被将来任何一个人或 AI 单独看懂：为什么会冒出这次提交、这一版算什么、
    // 哪些东西没被提交、想退回该怎么退。不要只写"auto commit"。
    const message =
      `同步前自动保存：${files.length} 个文件挡住了本次合并\n`
      + '\n'
      + '为什么会有这次提交\n'
      + '  下面列出的文件，本机改过、而远程这次也改了同一批文件。\n'
      + '  这种情况下 git 会拒绝合并（合并要写入这些文件，会覆盖掉本机还没保存进历史的修改），\n'
      + '  于是 Simple Git Sync 先把它们当前的状态提交一版，让合并能继续走下去。\n'
      + '  这不是定时快照，也不是谁手动点的——是合并被挡住时的自动让路。\n'
      + '\n'
      + '  清单里可能还有一批这次合并根本不会碰的文件：它们已经躺在暂存区（git add 过、没提交）。\n'
      + '  非快进合并要求暂存区与 HEAD 完全一致，只要还有一个已暂存的文件，git 就整个拒绝合并，\n'
      + '  所以它们也必须一起提交，否则同步走不下去。没 git add 过的改动一律没动。\n'
      + '\n'
      + '这一版算什么\n'
      + '  只是合并前的落脚点，不代表这些内容已经写完。\n'
      + '  继续编辑后正常再提交一次即可；想退回提交前的状态：git reset --soft HEAD^\n'
      + '\n'
      + `只提交了下面这 ${files.length} 个文件，工作区里没暂存过的改动一律没动：\n`
      + files.map(f => '  - ' + f).join('\n')
      + '\n\n'
      + `时间：${stamp}\n`;
    const r = await this.commitWithMessage(message);
    if (r.code !== 0) {
      this.notify('同步前保存失败：' + this.errLine(r), true);
      return false;
    }
    this.notify(`同步前已保存 ${files.length} 个挡路文件（其它没写完的改动未提交）`);
    return true;
  }

  // 冲突两阶段提交：
  // 第一步把所有冲突文件统一 checkout 成"较早/失败"的一侧、提交（真正的两父 merge commit，
  //   本地和远程分支在这里正式汇合，不留孤立分支）；
  // 第二步把这些文件改成"较晚/胜出"的一侧，再提交一次（普通单父提交，成为新 HEAD）。
  // 全程不产生任何额外文件；失败的那版完整留在主线历史第一步的提交里，顺着 git log 就能看到。
  async resolveConflictTwoPhase(files, remoteRef) {
    const localSha = (await this.git('rev-parse HEAD')).out;
    const remoteSha = (await this.git(`rev-parse ${remoteRef}`)).out;

    const decisions = [];
    for (const f of files) {
      // ① 先分清"增/删冲突"：一侧有这个文件、另一侧没有。
      //    这种情况下必有一侧的时间戳查不到，老逻辑会一路退化到 Math.random()，
      //    等于抛硬币决定这个文件是留还是删——2026-07-28 的 3-wiki/wiki.md 与
      //    0-Inbox/线性校准参数位置图.svg 就是这样被静默删掉的。
      //    一律保留"文件存在"的那一侧：多留一个文件顶多是冗余，看得见、随时能再删；
      //    删掉一个文件是静默的，可能几个月都没人发现。
      const localHas = await this.fileExistsIn(localSha, f);
      const remoteHas = await this.fileExistsIn(remoteSha, f);
      if (localHas !== remoteHas) {
        decisions.push({
          file: f,
          winnerSha: localHas ? localSha : remoteSha,
          loserSha: localHas ? remoteSha : localSha,
          basis: `增/删冲突：${localHas ? '远程' : '本地'}没有此文件，保留存在的一侧以免静默删除`,
        });
        continue;
      }

      const localTime = await this.fileCommitTime(localSha, f);
      const remoteTime = await this.fileCommitTime(remoteSha, f);
      let loserSha, winnerSha, basis;
      if (localTime !== null && remoteTime !== null && localTime !== remoteTime) {
        const localEarlier = localTime < remoteTime;
        loserSha = localEarlier ? localSha : remoteSha;
        winnerSha = localEarlier ? remoteSha : localSha;
        basis = `按提交时间：本地=${localTime}，远程=${remoteTime}`;
      } else {
        // 提交时间打平或缺失：退化比较作者时间（author date，跟 committer date 可能不同）
        const localAuthorTime = await this.fileCommitTime(localSha, f, '%at');
        const remoteAuthorTime = await this.fileCommitTime(remoteSha, f, '%at');
        if (localAuthorTime !== null && remoteAuthorTime !== null && localAuthorTime !== remoteAuthorTime) {
          const localEarlier = localAuthorTime < remoteAuthorTime;
          loserSha = localEarlier ? localSha : remoteSha;
          winnerSha = localEarlier ? remoteSha : localSha;
          basis = `提交时间打平，按作者时间：本地=${localAuthorTime}，远程=${remoteAuthorTime}`;
        } else {
          // 两侧都有这个文件、时间戳也完全打平。原来这里用 Math.random()，
          // 后果是两台机器解同一个冲突会解出不同结果、再互相合并一次，永远收敛不了。
          // 改成确定性规则：一律留本地。理由是本地这份此刻就在用户眼前的 Obsidian 里，
          // 被覆盖会当场感知；远程那份仍完整留在第一次提交里，可随时取回。
          loserSha = remoteSha;
          winnerSha = localSha;
          basis = '提交时间/作者时间均打平，按固定规则保留本地（远程版留在上一个提交里可取回）';
        }
      }
      decisions.push({ file: f, loserSha, winnerSha, basis });
    }

    // 兜底：winnerSha 那一侧本身就带着未解决的 <<<<<<< 冲突标记时，不能让它照样"胜出"。
    // 上面这套判定只看提交时间先后，不检查内容干不干净——如果 localSha 恰好是一次
    // commitBlockers() 把已经脏掉的文件原样存下来的快照（正常情况下 commitBlockers
    // 现在会主动挡掉这种文件，但历史提交、或跑的是还没重载的旧版代码时仍可能发生），
    // 按时间戳它常常是"更晚"的一侧，于是标记就这样被当成"较新内容"正式定下来。
    // 这里逐个检查 winnerSha 的内容，带标记就与 loserSha 对调（干净的那侧胜出）；
    // 两侧都带标记就没有更好的选择，原样保留并在 basis 里说明，交给人处理。
    for (const d of decisions) {
      const winnerDirty = await this.blobHasConflictMarkers(d.winnerSha, d.file);
      if (!winnerDirty) continue;
      const loserDirty = await this.blobHasConflictMarkers(d.loserSha, d.file);
      if (!loserDirty) {
        [d.winnerSha, d.loserSha] = [d.loserSha, d.winnerSha];
        d.basis += '；⚠️ 原判定的胜出版内容里仍带冲突标记，已改选另一侧（内容干净）';
      } else {
        d.basis += '；⚠️ 两侧内容都带着未解决的冲突标记，需人工处理';
      }
    }

    // 第一次提交：全部改成"较早/失败"版本 —— 这一步 commit 完成后本地/远程分支正式合并（两父提交）
    for (const d of decisions) await this.checkoutFileFromCommit(d.loserSha, d.file);
    if (!await this.stageResolved(decisions, '同步合并')) return false;
    await this.commitWithMessage(this.buildConflictMessage(
      '同步合并（临时快照，保留较早版本，紧接着会被下一次提交覆盖）', decisions, 'loserSha'));

    // 第二次提交：改成"较晚/胜出"版本，成为新 HEAD
    for (const d of decisions) await this.checkoutFileFromCommit(d.winnerSha, d.file);
    if (!await this.stageResolved(decisions, '同步合并')) return false;
    await this.commitWithMessage(this.buildConflictMessage(
      '同步合并：按时间顺序采用较新内容', decisions, 'winnerSha'));
    return true;
  }

  // 只暂存本次冲突涉及的文件，逐个精确 add。
  //
  // 这里原来是 `git add -A`，那是把冲突标记写进笔记的直接原因：它会把工作区里**所有**文件
  // 一并暂存，包括还带着 <<<<<<< / ======= / >>>>>>> 标记、根本没被解决的文件，
  // 于是标记就这样被当成正文提交进版本库（2026-07-28~29 波及 24 篇笔记、97 处）。
  // 而且合并本身产生的非冲突改动 git merge 早已自动放进索引，这里根本不需要 add -A 兜底，
  // 只需把冲突文件标记为已解决即可。
  async stageResolved(decisions, what) {
    const files = decisions.map(d => d.file);
    const blocked = await this.lfsBlocked(files);
    if (blocked) { this.notifyLfsBlocked(blocked, what); return false; }
    for (const d of decisions) {
      // checkoutFileFromCommit 里走 `git rm` 的那种（要采用的那一侧没有这个文件）已经把删除
      // 放进索引，此时路径在工作区和索引里都不存在，再 add 会报
      // "pathspec ... did not match any files"。这种情况无事可做，跳过即可。
      if (await this.pathGone(d.file)) continue;
      const r = await this.git(`add -A -- ${this.quotePath(d.file)}`);
      if (r.code !== 0) {
        this.notify(`${what}失败（暂存 ${d.file}）：` + (r.err || r.out).split('\n')[0], true);
        return false;
      }
    }
    const left = await this.git('-c core.quotepath=false diff --name-only --diff-filter=U');
    if (left.out) {
      this.notify(`${what}中止：仍有未解决的冲突文件，未提交。请手工处理：\n` + left.out.split('\n').slice(0, 5).join('\n'), true);
      return false;
    }
    return true;
  }

  // 某个提交的树里到底有没有这个文件。用来分辨"增/删冲突"——
  // 光看时间戳分不出"对方改晚了"和"对方压根没有这个文件"，而这两者的处理方式完全相反。
  async fileExistsIn(sha, file) {
    return (await this.git(`cat-file -e ${sha}:${this.quotePath(file)}`)).code === 0;
  }

  // 某个提交里，这个文件的内容本身是不是还带着未解决的 <<<<<<< / ======= / >>>>>>> 标记。
  // 用来防止 resolveConflictTwoPhase 把一个本身就是垃圾（比如 commitBlockers 快照进去的
  // 半成品）的候选版本当"胜出"内容永久定下来。
  async blobHasConflictMarkers(sha, file) {
    const r = await this.git(`show ${sha}:${this.quotePath(file)}`);
    if (r.code !== 0) return false;
    return /^<<<<<<< |^=======$|^>>>>>>> /m.test(r.out);
  }

  // 某个文件在某个提交（及其之前）最后一次改动的时间戳；file 在该提交里不存在则返回 null
  async fileCommitTime(sha, file, format) {
    const r = await this.git(`log -1 --format=${format || '%ct'} ${sha} -- ${this.quotePath(file)}`);
    if (r.code === 0 && r.out) return parseInt(r.out, 10);
    return null;
  }

  // 把 file 在工作区里替换成 sha 版本的内容；sha 里这个文件不存在（对方删了）就删掉工作区里这份
  async checkoutFileFromCommit(sha, file) {
    const exists = await this.git(`cat-file -e ${sha}:${this.quotePath(file)}`);
    if (exists.code === 0) {
      await this.git(`checkout ${sha} -- ${this.quotePath(file)}`);
    } else {
      await this.git(`rm -f -- ${this.quotePath(file)}`);
    }
  }

  buildConflictMessage(title, decisions, shaKey) {
    const lines = decisions.map(d => `- ${d.file}\n  采用 ${d[shaKey].slice(0, 10)}　${d.basis}`);
    return `${title}\n\n涉及文件与判定依据：\n${lines.join('\n')}`;
  }

  async doPush(manual) {
    if (!await this.acquire(LOCK_WAIT_MS)) {
      // 等满了还没轮到：不硬闯（会和前一件事抢同一个仓库），这次安静让过。
      if (manual) this.notify('上一个 git 操作还没做完，请稍后再试', true);
      return;
    }
    this.setStatus('Git Sync: 推送中…');
    try {
      // 推送前再查一次跨平台非法文件名。runSync 开头已经查过一遍，这里不是重复：
      //   1. doPush 也可能被单独调用（手动推送），那条路不经过 runSync 的前置检查；
      //   2. 更关键的是，两次检查之间夹着一次 doPull——合并可能把别的机器推来的非法名
      //      带进本机工作区，而入口消毒 sanitizeIncomingIfNeeded 只在 Windows 上跑，
      //      Mac 合完根本不检查，转手就会把它推回远程，等于帮着扩散。
      // 放在 ahead 计数之前：改名会产生新提交，先算 ahead 会漏掉它。
      if (!await this.sanitizeLocalNames(manual)) {
        this.setStatus('Git Sync: 推送已中止（非法文件名未能修正）');
        return;
      }
      const remote = await this.resolveRemote(manual);
      if (!remote) { this.setStatus('Git Sync: 未选定远程'); return; }
      const branch = await this.currentBranch();
      // 推之前先把尖端连续的自动提交折叠成一个：分支尖端永远不出现两个连续的自动提交。
      // 必须放在 ahead 计数之前——折叠会改变未推送提交的数量。
      await this.squashAutoCommits(remote, branch);
      // 先看有没有未推送的提交；没有就直接跳过（自动模式下不打扰）
      const ahead = await this.git(`rev-list --count ${remote}/${branch}..HEAD`);
      if (ahead.code === 0 && ahead.out === '0') {
        this._pushNothing = true; // 没东西可推，供 runSync 判断是否收敛
        if (manual) this.notify('没有需要推送的提交');
        this.setStatus('Git Sync: 就绪');
        return;
      }
      const r = await this.gitNet(`push ${remote} ${branch}`);
      if (r.code !== 0 && !/up-to-date/i.test(r.err)) {
        // 报错取第一句"实质"错误：跳过 git 的 warning:/hint: 噪音（如 LF/CRLF 警告、
        // LFS 锁提示），否则弹窗常显示一句与失败无关的警告，让人误判。
        const lines = (r.err || r.out).split('\n').map(s => s.trim()).filter(Boolean);
        const real = lines.find(l => !/^(warning|hint|remote:）?)/i.test(l)) || lines[0] || '未知错误';
        // 网络不通和"被远程拒绝（non-fast-forward 等）"要分开报：后者下一轮 pull 完还有救，
        // 前者再试多少轮都是白等，必须立刻停下并说清楚是远程的问题，别让人以为是插件坏了。
        if (r.netDown) this.reportNetDown('推送', real);
        else {
          this.notify('推送失败：' + real, true);
          this.setStatus('Git Sync: 推送失败');
        }
      } else {
        this.notify('已推送到 ' + remote);
        this.setStatus('Git Sync: 就绪');
      }
    } finally { this.busy = false; }
  }
};

// 本机配了多个远程、而设置里又没选定时，弹这个窗让人选一次。
// 关窗（Esc / 点外面）等于不选，onClose 统一 resolve，保证调用方的 await 一定会返回。
class RemoteChooserModal extends Modal {
  constructor(app, remotes, invalidName, onPick) {
    super(app);
    this.remotes = remotes;
    this.invalidName = invalidName;
    this.onPick = onPick;
    this.picked = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Git Sync：这次同步用哪个远程？' });
    contentEl.createEl('p', {
      text: this.invalidName
        ? `插件设置里填的是 "${this.invalidName}"，但这台机器上没有这个远程。本机配了多个远程，请选一个：`
        : '这台机器配了多个远程，请选一个用于同步：',
    });
    for (const r of this.remotes) {
      new Setting(contentEl)
        .setName(r)
        .addButton(b => b.setButtonText('用这个').setCta().onClick(() => { this.picked = r; this.close(); }));
    }
    contentEl.createEl('p', { text: '选择会记进插件设置，之后不再询问；要改可以去设置里改。' });
  }

  onClose() {
    this.contentEl.empty();
    this.onPick(this.picked);
  }
}

class SimpleGitSyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveData(s); this.plugin.applyTimers(); };

    new Setting(containerEl)
      .setName('启用自动同步（总开关）')
      .setDesc('关掉后自动同步与自动 commit 定时器全停；命令面板里的手动命令仍可用')
      .addToggle(tg => tg.setValue(s.enabled).onChange(async v => { s.enabled = v; await save(); }));

    new Setting(containerEl)
      .setName('自动同步间隔（分钟，0=关闭）')
      .setDesc('每隔这么久自动同步一次：pull → push 串行执行，和左侧栏"手动同步"按钮完全一样（老版本的 pull/push 两个间隔已合并成这一个）。遇到真正的合并冲突时按时间顺序分两次提交解决，不产生额外文件')
      .addText(t => t.setValue(String(s.syncInterval)).onChange(async v => { s.syncInterval = parseInt(v) || 0; await save(); }));

    new Setting(containerEl)
      .setName('自动 commit 间隔（分钟，0=关闭）')
      .setDesc('完全独立于自动同步，可以单独开、单独关。定时把工作区当前改动打包提交一次（git add -A + commit），不涉及冲突处理')
      .addText(t => t.setValue(String(s.commitInterval)).onChange(async v => { s.commitInterval = parseInt(v) || 0; await save(); }));

    new Setting(containerEl)
      .setName('拉取前自动保存"挡路文件"')
      .setDesc('本机改过、且远程这次也改了的文件会让 git 直接拒绝合并。开启后只把这几个文件提交一版（逐个精确暂存，不是 add -A，工作区其它没写完的改动不受影响）；关闭则遇到这种情况跳过本次拉取并列出文件名，由你自己处理')
      .addToggle(tg => tg.setValue(s.commitBlockersBeforePull).onChange(async v => { s.commitBlockersBeforePull = v; await save(); }));

    // 远程用下拉选，选项来自本机真实配置的远程，不让人手打——手打出来的名字在别的机器上
    // 往往不存在，正是配置跨机同步后同步失效的根源。
    const remoteSetting = new Setting(containerEl)
      .setName('远程')
      .setDesc('读取中…');
    this.plugin.listRemotes().then(remotes => {
      if (!remotes.length) {
        remoteSetting.setDesc('这个仓库没有配置任何远程，无法同步');
        return;
      }
      remoteSetting.setDesc(
        remotes.length === 1
          ? `本机只有一个远程（${remotes[0]}），选"自动"即可`
          : `本机有多个远程：${remotes.join('、')}。选"自动"时插件会弹窗问你用哪个`
      );
      remoteSetting.addDropdown(d => {
        d.addOption('', '自动（只有一个远程时直接用）');
        for (const r of remotes) d.addOption(r, r);
        d.setValue(remotes.includes(s.remote) ? s.remote : '');
        d.onChange(async v => { s.remote = v; await save(); });
      });
    });

    new Setting(containerEl)
      .setName('分支（留空 = 当前分支）')
      .addText(t => t.setValue(s.branch).onChange(async v => { s.branch = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName('每次成功都弹提示')
      .setDesc('关掉后只在出错时提示')
      .addToggle(tg => tg.setValue(s.showNotices).onChange(async v => { s.showNotices = v; await save(); }));

    new Setting(containerEl)
      .setName('附加 PATH（手动兜底，一般留空）')
      .setDesc('插件会先自动探测系统真实 PATH（Mac 走登录 shell、Windows/Linux 直接用系统 PATH），通常不用填。只有探测后仍找不到 git 时才需要手动在这里补目录；多个目录用英文逗号分隔，同一份配置可跨 Mac/Windows 通用')
      .addText(t => t.setValue(s.extraPath).onChange(async v => { s.extraPath = v; await save(); }));
  }
}
