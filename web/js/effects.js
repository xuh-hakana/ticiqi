/* ===========================================================================
   命令方块 · 交互层（v2）
   ---------------------------------------------------------------------------
   不修改 app.js 的任何函数，全部靠 DOM 事件委托 + MutationObserver 叠加：
   1) 鼠标悬浮命令行 → 该行文字以「数据化渐变」变成对应解释，只翻译
      命令 / 关键字 / 属性，字符串、数字、路径、未登记的名字一律原样保留。
   2) 文件被外部改动（SSE tree 事件 + 当前文件重画）→ 变化的行飞入砸进
      代码面板，配一次很轻的冲击反馈和一条 HUD 提示；同时在左侧文件树上给
      改过的文件打一颗青点，父目录打一颗空心圈（不展开也知道哪里动了）。
   3) 只在命令方块里生效：提词器已拆成单独的客户端（提词器.app），
      那个页面不加载任何文件特效。
   =========================================================================== */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 术语库：键 = 命令 / 关键字 / 属性，值 = 简短中文含义。
  // 只登记「有语义的词」。具体的值（字符串、数字、路径、自定义变量名）不查表，
  // 一律原样保留，这样悬浮时看到的是「端口: 8899」而不是整行被替换掉。
  // -------------------------------------------------------------------------
  var DICT = {
    // JavaScript / TypeScript
    'const': '常量', 'let': '变量', 'var': '变量', 'function': '函数', 'return': '返回',
    'if': '如果', 'else': '否则', 'for': '遍历', 'while': '循环', 'do': '执行',
    'class': '类', 'new': '新建实例', 'this': '当前对象', 'super': '父类',
    'import': '引入', 'from': '来自', 'export': '导出', 'default': '默认',
    'async': '异步', 'await': '等待', 'try': '尝试', 'catch': '捕获异常',
    'throw': '抛出', 'finally': '收尾', 'typeof': '取类型', 'instanceof': '判断实例',
    'switch': '分支', 'case': '匹配', 'break': '跳出', 'continue': '下一轮',
    'delete': '删除', 'in': '属于', 'of': '取自', 'extends': '继承',
    'static': '静态', 'yield': '让出', 'void': '无返回', 'null': '空值',
    'undefined': '未定义', 'true': '真', 'false': '假',
    // 常见 API / 属性
    'path': '路径', 'root': '根目录', 'file': '文件', 'files': '文件列表',
    'dir': '目录', 'name': '名称', 'content': '内容', 'data': '数据',
    'error': '错误', 'message': '消息', 'log': '日志', 'port': '端口',
    'host': '主机', 'url': '地址', 'method': '方法', 'body': '请求体',
    'status': '状态', 'code': '代码', 'res': '响应', 'req': '请求',
    'result': '结果', 'value': '值', 'key': '键', 'id': '编号',
    'type': '类型', 'length': '长度', 'index': '索引', 'list': '列表',
    'array': '数组', 'string': '字符串', 'number': '数字', 'boolean': '布尔',
    'object': '对象', 'json': 'JSON 数据', 'config': '配置', 'options': '选项',
    'state': '状态', 'store': '存储', 'read': '读取', 'write': '写入',
    'open': '打开', 'close': '关闭', 'create': '创建', 'update': '更新',
    'remove': '移除', 'push': '追加', 'pop': '弹出', 'map': '映射',
    'filter': '筛选', 'find': '查找', 'includes': '包含', 'join': '拼接',
    'split': '切分', 'replace': '替换', 'trim': '去空格', 'slice': '截取',
    'parse': '解析', 'stringify': '序列化', 'require': '加载模块',
    'module': '模块', 'exports': '导出', 'process': '进程', 'console': '控制台',
    'window': '窗口', 'document': '页面', 'fs': '文件系统', 'os': '系统',
    'buffer': '缓冲区', 'promise': '异步结果', 'resolve': '完成', 'reject': '拒绝',
    'then': '接着', 'finally': '收尾', 'length': '长度',
    'electron': '桌面框架', 'app': '应用', 'ipcMain': '主进程通信',
    'ipcRenderer': '渲染进程通信', 'BrowserWindow': '窗口', 'dialog': '对话框',
    'clipboard': '剪贴板', 'shell': '系统外壳', 'http': 'HTTP 服务',
    'https': 'HTTPS 服务', 'crypto': '加密', 'server': '服务', 'listen': '监听',
    // Python
    'def': '定义函数', 'self': '实例自身', 'as': '别名', 'with': '上下文',
    'lambda': '匿名函数', 'None': '空值', 'True': '真', 'False': '假',
    'pass': '占位', 'raise': '抛出异常', 'except': '捕获异常', 'elif': '否则如果',
    'global': '全局', 'nonlocal': '外层变量', 'print': '打印', 'len': '长度',
    'str': '字符串', 'int': '整数', 'dict': '字典', 'tuple': '元组',
    'set': '集合', 'range': '范围', 'sys': '系统模块', 'time': '时间',
    'Path': '路径对象', 'pathlib': '路径库', 'import': '引入',
    // Shell / 命令行
    'git': '版本控制', 'add': '加入暂存', 'commit': '提交变更', 'push': '推送远端',
    'pull': '拉取远端', 'clone': '克隆仓库', 'status': '查看状态', 'log': '查看历史',
    'branch': '分支', 'checkout': '切换', 'merge': '合并', 'reset': '回退',
    'cd': '进入目录', 'ls': '列出文件', 'mkdir': '新建目录', 'rm': '删除',
    'cp': '复制', 'mv': '移动', 'cat': '查看内容', 'echo': '输出',
    'npm': '包管理', 'npx': '临时运行包', 'node': '运行 Node', 'python': '运行 Python',
    'python3': '运行 Python3', 'pip': '装 Python 包', 'curl': '发请求',
    'sudo': '管理员权限', 'chmod': '改权限', 'grep': '搜索文本',
    'find': '查找文件', 'sed': '替换文本', 'awk': '按列处理',
    'pkill': '结束进程', 'pgrep': '查进程', 'kill': '终止', 'lsof': '查端口占用',
    'open': '打开', 'export': '设环境变量', 'source': '加载脚本',
    // 配置 / 文档结构
    'version': '版本', 'main': '入口', 'scripts': '脚本', 'dependencies': '依赖',
    'devDependencies': '开发依赖', 'enabled': '已启用', 'disabled': '已停用',
    'TODO': '待办', 'NOTE': '备注', 'FIXME': '待修', 'HACK': '临时方案',
    'requirement': '需求', 'readonly': '只读', 'readOnly': '只读',
    // 项目专有词
    'xuhbot': '虚幻机器人', 'CommandBlock': '命令方块', 'command-block': '命令方块',
    'sticker': '表情包', 'favor': '好感度', 'people': '人物', 'trigger': '触发词',
    'persona': '人设', 'prompt': '提示词', 'snapshot': '快照', 'broadcast': '广播',
    'signature': '变更签名', 'mtime': '修改时间', 'sse': '实时推送',
  };

  var STRUCT = { '#': '标题', '##': '二级标题', '###': '三级标题', '####': '四级标题', '---': '分隔线', '```': '代码块' };
  // 两个客户端共用同一份页面；提词器独立客户端只跑需求库，不挂代码特效。
  var isPrompterApp = document.documentElement.dataset.app === 'prompter';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 把一行切成「可翻译片段」与「保留片段」。返回 {html, changed}
  function explainLine(raw) {
    var text = String(raw || '');
    if (!text.trim()) return { html: '', changed: false };
    var trimmed = text.trim();
    if (trimmed.charAt(0) === '#' && STRUCT[trimmed.split(/\s/)[0]]) {
      var head = trimmed.split(/\s/)[0];
      return { html: '<span class="cb-ex-cmd">' + esc(STRUCT[head]) + '</span><span class="cb-ex-lit">' + esc(text.slice(text.indexOf(head) + head.length)) + '</span>', changed: true };
    }
    if (/^(\/\/|;|#\s)/.test(trimmed)) return { html: '', changed: false }; // 整行注释：不打扰

    var re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$-]*)|(\s+)|([^\sA-Za-z0-9_$])/g;
    var out = [], m, last = 0, changed = false;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push('<span class="cb-ex-punc">' + esc(text.slice(last, m.index)) + '</span>');
      if (m[1]) {
        out.push('<span class="cb-ex-lit">' + esc(m[1]) + '</span>');           // 字符串：值，保留
      } else if (m[2]) {
        out.push('<span class="cb-ex-lit">' + esc(m[2]) + '</span>');           // 数字：值，保留
      } else if (m[3]) {
        var word = m[3];
        if (Object.prototype.hasOwnProperty.call(DICT, word)) {
          out.push('<span class="cb-ex-cmd">' + esc(DICT[word]) + '</span>');
          changed = true;
        } else {
          out.push('<span class="cb-ex-lit">' + esc(word) + '</span>');         // 未登记的名字：值，保留
        }
      } else if (m[4]) {
        out.push(m[4].replace(/ /g, '&nbsp;'));
      } else {
        out.push('<span class="cb-ex-punc">' + esc(m[5]) + '</span>');
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.push('<span class="cb-ex-punc">' + esc(text.slice(last)) + '</span>');
    return { html: out.join(''), changed: changed };
  }

  // -------------------------------------------------------------------------
  // 1) 悬浮解释：事件委托到 #codeLines，只处理 .code-line
  // -------------------------------------------------------------------------
  var activeLine = null;

  function restore() {
    if (!activeLine) return;
    var code = activeLine.querySelector('.line-code');
    var line = activeLine;
    activeLine = null;
    line.classList.remove('is-explain-target');
    if (!code) return;
    code.classList.add('cb-morph');
    setTimeout(function () {
      code.innerHTML = code.dataset.cbOrig || '';
      delete code.dataset.cbOrig;
      delete code.dataset.cbBusy;
    }, 110);
    setTimeout(function () { code.classList.remove('cb-morph'); }, 280);
  }

  function explain(line) {
    var code = line.querySelector('.line-code');
    if (!code || code.dataset.cbBusy) return;
    var ex = explainLine(code.textContent);
    if (!ex.changed) return;              // 这一行没有可翻译的命令：保持原样
    code.dataset.cbOrig = code.innerHTML;
    code.dataset.cbBusy = '1';
    line.classList.add('is-explain-target');
    activeLine = line;
    code.classList.add('cb-morph');
    setTimeout(function () { code.innerHTML = ex.html; }, 110);
    setTimeout(function () { code.classList.remove('cb-morph'); }, 280);
  }

  function bindExplain() {
    document.addEventListener('mouseover', function (e) {
      var line = e.target.closest && e.target.closest('.code-line');
      if (!line) return;
      if (activeLine === line) return;
      if (activeLine) restore();
      clearTimeout(bindExplain._t);
      bindExplain._t = setTimeout(function () { explain(line); }, 90); // 轻微防抖，划过不闪
    }, true);
    document.addEventListener('mouseout', function (e) {
      if (!activeLine) return;
      var line = e.target.closest && e.target.closest('.code-line');
      if (line === activeLine) {
        var related = e.relatedTarget;
        if (related && activeLine.contains(related)) return;
        restore();
      }
    }, true);
    document.addEventListener('scroll', function () { if (activeLine) restore(); }, true);
  }

  // -------------------------------------------------------------------------
  // 2) 实时改动 → 文字飞入砸进面板
  // -------------------------------------------------------------------------
  var refreshUntil = 0;       // SSE tree 事件之后的一小段时间窗口
  var snapshot = [];          // 上一次渲染的行文本
  var hudTimer = null;

  function lineTexts() {
    var box = document.getElementById('codeLines');
    if (!box) return [];
    return Array.prototype.map.call(box.querySelectorAll('.line-code'), function (n) { return n.textContent; });
  }

  function showHud(fileName, add, remove) {
    var old = document.querySelector('.cb-change-hud');
    if (old) old.remove();
    var hud = document.createElement('div');
    hud.className = 'cb-change-hud';
    var dot = document.createElement('span'); dot.className = 'cb-hud-dot';
    var t1 = document.createElement('span'); t1.textContent = '已同步';
    var f = document.createElement('span'); f.className = 'cb-hud-file'; f.textContent = fileName || '当前文件';
    var d = document.createElement('span'); d.className = 'cb-hud-diff';
    d.textContent = (add ? '+' + add + ' 行' : '') + (add && remove ? ' · ' : '') + (remove ? '-' + remove + ' 行' : '');
    if (!add && !remove) d.textContent = '内容已更新';
    hud.appendChild(dot); hud.appendChild(t1); hud.appendChild(f); hud.appendChild(d);
    document.body.appendChild(hud);
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () {
      hud.classList.add('is-leaving');
      setTimeout(function () { if (hud.parentNode) hud.remove(); }, 320);
    }, 2200);
  }

  function flyIn(prev, next) {
    var box = document.getElementById('codeLines');
    var wrap = document.getElementById('codeWrap');
    if (!box || !wrap) return;
    var lines = box.querySelectorAll('.code-line');
    var add = 0, remove = 0, shown = 0;
    for (var i = 0; i < next.length; i++) {
      if (prev[i] !== next[i]) { add++; }
    }
    for (var j = next.length; j < prev.length; j++) remove++;
    if (!add && !remove) return;

    for (var k = 0; k < lines.length && shown < 26; k++) {
      if (prev[k] !== next[k]) {
        var el = lines[k];
        el.classList.remove('cb-flyin');
        // 强制重排，保证同一行连续两次改动也能重播动画
        void el.offsetWidth;
        el.style.animationDelay = Math.min(shown * 18, 260) + 'ms';
        el.classList.add('cb-flyin');
        shown++;
      }
    }
    wrap.classList.remove('cb-impact');
    void wrap.offsetWidth;
    wrap.classList.add('cb-impact');
    var pathEl = document.getElementById('filePath');
    showHud(pathEl ? pathEl.textContent : '', add, remove);
  }

  function bindWatch() {
    // 自己开一条 SSE，只为知道「这次重画是外部改动触发的」；app.js 那条不受影响。
    try {
      var es = new EventSource('/api/events');
      es.addEventListener('tree', function (e) {
        refreshUntil = Date.now() + 4000;
        // 后端在这次事件里带了「哪些文件变了」，直接用，不再整棵拉一次 /api/tree。
        try { markChanged((JSON.parse(e.data || '{}') || {}).changed); } catch (err) { /* 老后端没有这个字段：跳过 */ }
      });
    } catch (e) { /* 浏览器不支持时退化：仍按内容变化判断，见下 */ }

    var box = document.getElementById('codeLines');
    if (!box) return;
    snapshot = lineTexts();
    var observer = new MutationObserver(function () {
      var next = lineTexts();
      // 条件：内容确实变了 + 是自动刷新窗口内（或根本没有 SSE 能力时按内容判断）
      var changed = next.length !== snapshot.length || next.some(function (v, i) { return v !== snapshot[i]; });
      if (changed && Date.now() < refreshUntil) {
        if (activeLine) restore();
        flyIn(snapshot, next);
      }
      snapshot = next;
    });
    observer.observe(box, { childList: true, subtree: false });

    // 手动切文件时 app.js 会先清空再重画，这里同步快照避免误判为改动
    document.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('.tree-row, .file-row, .fav-item, .symbol-row');
      if (row) { refreshUntil = 0; }
    }, true);
  }

  // -------------------------------------------------------------------------
  // 3) 自打开以来被改过的文件 → 树上打青点
  //    数据来源：SSE tree 事件里的 changed[]（后端扫描时顺手比出来的），
  //    不额外请求 /api/tree（那棵树约 1.9 MB，每个事件拉一次不划算）。
  // -------------------------------------------------------------------------
  var changedPaths = Object.create(null);   // 改过的文件 → 首次发现的时间戳
  var paintQueued = false;

  function clockOf(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function ancestorsOf(rel) {
    var parts = String(rel).split('/');
    var out = [];
    for (var i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
    return out;
  }

  function markChanged(paths) {
    if (!paths || !paths.length) return;
    var at = Date.now();
    var hit = false;
    for (var i = 0; i < paths.length; i++) {
      var p = String(paths[i] || '');
      if (!p || changedPaths[p]) continue;
      changedPaths[p] = at;
      hit = true;
    }
    if (hit) schedulePaint();
  }

  function paintChanged() {
    var tree = document.getElementById('fileTree');
    if (!tree) return;
    // 树每次重画都会丢掉 class，所以先整体清一遍再按当前 DOM 重挂
    Array.prototype.forEach.call(tree.querySelectorAll('.is-changed, .is-changed-below'), function (row) {
      row.classList.remove('is-changed', 'is-changed-below');
      if (row.dataset.cbBaseTitle) {
        row.title = row.dataset.cbBaseTitle;
        delete row.dataset.cbBaseTitle;
      }
    });
    // 折叠着的目录看不到子文件，把标记往上冒一层，保证不展开也知道「这里有改动」
    var folders = Object.create(null);
    Object.keys(changedPaths).forEach(function (rel) {
      ancestorsOf(rel).forEach(function (dir) { folders[dir] = true; });
    });
    Array.prototype.forEach.call(tree.querySelectorAll('.tree-row[data-path]'), function (row) {
      var rel = row.dataset.path;
      var at = changedPaths[rel];
      var folderHit = row.dataset.kind === 'folder' && folders[rel];
      if (!at && !folderHit) return;
      if (!row.dataset.cbBaseTitle) row.dataset.cbBaseTitle = row.title || rel;
      row.classList.add(at ? 'is-changed' : 'is-changed-below');
      row.title = row.dataset.cbBaseTitle + (at ? ' · 打开后被改过 ' + clockOf(at) : ' · 这下面有改过的文件');
    });
    // 扇形图要同一份「哪些文件改过」的数据，打完点顺手通知它重画。
    if (typeof window.cbPieRefresh === 'function') window.cbPieRefresh();
  }

  // 给扇形图用的只读出口：返回自打开以来被改过的文件（相对根目录的路径）。
  window.cbChangedPaths = function () { return Object.keys(changedPaths); };

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(function () { paintQueued = false; paintChanged(); });
  }

  function bindChangedMarks() {
    var tree = document.getElementById('fileTree');
    if (!tree) return;
    // 同步、筛选、展开折叠都会重画树，重画后补一次（只扫 class，不碰数据）
    new MutationObserver(schedulePaint).observe(tree, { childList: true, subtree: true });
  }

  function boot() {
    // 提词器独立客户端没有代码行、没有文件树，这些特效一个都不挂。
    if (isPrompterApp) return;
    bindExplain();
    bindWatch();
    bindChangedMarks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
