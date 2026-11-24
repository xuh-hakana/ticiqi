/* Lightweight, dependency-free syntax highlighting. Every token is escaped
   before it becomes markup; unknown languages fall back to plain text. */

const KEYWORDS = {
  javascript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined".split(" ")),
  typescript: new Set("as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace never new of private protected public readonly return satisfies set static super switch this throw try type typeof undefined unique unknown var void while with yield true false null".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case".split(" ")),
  go: new Set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil".split(" ")),
  rust: new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
  java: new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null record var".split(" ")),
  c: new Set("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true false NULL".split(" ")),
  cpp: new Set("alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while".split(" ")),
  csharp: new Set("abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while".split(" ")),
  ruby: new Set("alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield".split(" ")),
  php: new Set("abstract and array as break callable case catch class clone const continue declare default die do echo elseif else empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null".split(" ")),
  swift: new Set("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try".split(" ")),
  kotlin: new Set("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg".split(" ")),
  shell: new Set("if then else elif fi for while in do done case esac function select until time return exit export readonly local declare typeset unset shift source alias echo printf cd pwd test true false".split(" ")),
  sql: new Set("select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset union all as and or not null is in like between distinct case when then else end primary key foreign references default".split(" ")),
  yaml: new Set("true false null yes no on off".split(" ")),
  toml: new Set("true false".split(" ")),
};

const TYPE_LANGUAGES = new Set(["javascript", "typescript", "python", "go", "rust", "java", "c", "cpp", "csharp", "swift", "kotlin", "java"]);

const LABELS = {
  javascript: "JS", typescript: "TS", python: "PY", json: "JSON", markdown: "MD",
  css: "CSS", html: "HTML", xml: "XML", shell: "SH", yaml: "YAML", toml: "TOML",
  ini: "INI", sql: "SQL", go: "GO", rust: "RS", java: "JAVA", c: "C", cpp: "C++",
  csharp: "C#", ruby: "RB", php: "PHP", swift: "SWIFT", kotlin: "KT", scala: "SCALA",
  lua: "LUA", r: "R", perl: "PL", elixir: "EX", docker: "DOCKER", make: "MAKE",
  text: "TXT", csv: "CSV", other: "FILE",
};

export function languageLabel(language) {
  return LABELS[language] || String(language || "FILE").toUpperCase().slice(0, 8);
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function span(cls, text) {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

function isTypeIdentifier(word) {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(word) && word.length > 1;
}

function genericTokenize(line, language) {
  const keywords = KEYWORDS[language] || new Set();
  const commentPattern =
    language === "python" || language === "shell" || language === "yaml" || language === "toml" || language === "ini" || language === "make"
      ? "#[^\\n]*"
      : language === "sql"
        ? "--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"
        : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  const re = new RegExp(
    `(?<comment>${commentPattern})` +
      `|(?<string>${language === "python" ? `"""([\\s\\S]*?)"""|'''([\\s\\S]*?)'''|` : ""}"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\x60(?:\\\\.|[^\\x60\\\\])*\\x60)` +
      `|(?<number>\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b)` +
      `|(?<ident>[A-Za-z_$][\\w$]*)` +
      `|(?<punct>[{}()\\[\\];,.])`,
    "g",
  );
  let out = "";
  let last = 0;
  let match;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) out += escapeHtml(line.slice(last, match.index));
    const groups = match.groups || {};
    if (groups.comment) out += span("com", match[0]);
    else if (groups.string) out += span("str", match[0]);
    else if (groups.number) out += span("num", match[0]);
    else if (groups.punct) out += span("punc", match[0]);
    else if (groups.ident) {
      const word = match[0];
      if (keywords.has(word)) out += span("kw", word);
      else {
        let next = re.lastIndex;
        while (next < line.length && /\s/.test(line[next])) next += 1;
        if (line[next] === "(" && !["if", "for", "while", "switch", "catch"].includes(word)) out += span("fn", word);
        else if (TYPE_LANGUAGES.has(language) && isTypeIdentifier(word)) out += span("type", word);
        else out += escapeHtml(word);
      }
    } else out += escapeHtml(match[0]);
    last = re.lastIndex;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out;
}

function highlightMarkup(line) {
  const escaped = escapeHtml(line);
  if (/^\s*<!--/.test(line)) return span("com", line);
  let out = "";
  let index = 0;
  const re = /(<\/?)([A-Za-z][\w:-]*)((?:\s+[^<>]*?)?)(\/?>)|([^<]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[5] !== undefined) {
      out += escapeHtml(m[5]);
      continue;
    }
    out += span("punc", m[1]) + span("tag", m[2]);
    if (m[3]) {
      out += String(m[3]).replace(
        /(\s+)([A-Za-z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')?/g,
        (_full, space, attr, eq, value) =>
          escapeHtml(space) + span("attr", attr) + span("punc", eq) + (value ? span("str", value) : ""),
      );
    }
    out += span("punc", m[4]);
    index = re.lastIndex;
  }
  if (index < line.length) out += escapeHtml(line.slice(index));
  return out || escaped;
}

function highlightMarkdown(line) {
  if (/^\s*```/.test(line)) return span("com", line);
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) return span("head", line);
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
    return escapeHtml(line).replace(/^(\s*)([-*+]|\d+\.)/, (_m, s, marker) => `${s}${span("kw", marker)}`);
  }
  if (/^\s*>\s?/.test(line)) return span("com", line);
  let out = escapeHtml(line);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<span class="tok-str">${code}</span>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, text) => `<span class="tok-type">${text}</span>`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => `<span class="tok-link">${text}</span><span class="tok-punc">(${href})</span>`);
  return out;
}

function highlightJson(line) {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/gi;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out += escapeHtml(line.slice(last, m.index));
    if (m[1]) out += span(m[2] ? "key" : "str", m[1]);
    else if (m[2]) out += escapeHtml(m[2]);
    else if (m[3]) out += span("kw", m[3]);
    else if (m[4]) out += span("num", m[4]);
    last = re.lastIndex;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out;
}

function highlightYaml(line, language) {
  const commentIndex = line.indexOf("#");
  const comment = commentIndex >= 0 ? line.slice(commentIndex) : "";
  const body = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  let out;
  const key = body.match(/^(\s*(?:-\s*)?)([A-Za-z0-9_.-]+)(\s*:)(.*)$/);
  if (key) {
    out = escapeHtml(key[1]) + span("key", key[2]) + span("punc", key[3]) + genericTokenize(key[4], language);
  } else {
    out = genericTokenize(body, language);
  }
  if (comment) out += span("com", comment);
  return out;
}

export function highlightLine(line, language) {
  try {
    if (!line) return "";
    if (language === "markdown") return highlightMarkdown(line);
    if (language === "json" || language === "jsonc") return highlightJson(line);
    if (language === "html" || language === "xml" || language === "vue" || language === "svelte") return highlightMarkup(line);
    if (language === "yaml" || language === "toml" || language === "ini") return highlightYaml(line, language);
    if (language === "text" || language === "other" || language === "csv") return escapeHtml(line);
    return genericTokenize(line, language);
  } catch {
    return escapeHtml(line);
  }
}
