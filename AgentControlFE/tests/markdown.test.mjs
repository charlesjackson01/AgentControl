import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseMarkdown, safeHref } from '../src/lib/markdown.ts'
import { renderMarkdown } from '../src/lib/markdown-render.ts'

const html = (md) => renderToStaticMarkup(renderMarkdown(md))
const inner = (md) => html(md).replace(/^<div class="cf-md">|<\/div>$/g, '')

/** Every tag name in the output; the renderer may only ever emit these. */
const ALLOWED_TAGS = new Set(['div', 'p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'br'])
const ALLOWED_ATTRS = new Set(['class', 'href', 'target', 'rel', 'start'])
function assertOnlySafeMarkup(out) {
  for (const [, tag] of out.matchAll(/<\/?([a-zA-Z][\w-]*)/g)) assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `unexpected <${tag}> in ${out}`)
  for (const [, attrs] of out.matchAll(/<[a-zA-Z][\w-]*([^>]*)>/g)) {
    for (const [, name] of attrs.matchAll(/([^\s=/]+)(?:="[^"]*")?/g)) assert.ok(ALLOWED_ATTRS.has(name.toLowerCase()), `unexpected attribute ${name} in ${out}`)
  }
  for (const [, href] of out.matchAll(/href="([^"]*)"/g)) assert.match(href, /^(https?:\/\/|mailto:)/, `href ${href}`)
}

describe('markdown: supported elements', () => {
  it('bold, italics and inline code (mockup 04: "the pier as **240 m**")', () => {
    assert.equal(inner('The plan gives the pier as **240 m**, the sketch __240 ft__.'), '<p>The plan gives the pier as <strong>240 m</strong>, the sketch <strong>240 ft</strong>.</p>')
    assert.equal(inner('*one* and _two_'), '<p><em>one</em> and <em>two</em></p>')
    assert.match(inner('***both***'), /^<p><strong><em>both<\/em><\/strong><\/p>$/)
    assert.equal(inner('run `npm ci` first'), '<p>run <code class="cf-md__code">npm ci</code> first</p>')
    assert.equal(inner('``a `tick` b``'), '<p><code class="cf-md__code">a `tick` b</code></p>')
  })
  it('emphasis inside code and code inside bold', () => {
    assert.equal(inner('`**not bold**`'), '<p><code class="cf-md__code">**not bold**</code></p>')
    assert.equal(inner('**see `x`**'), '<p><strong>see <code class="cf-md__code">x</code></strong></p>')
  })
  it('snake_case, 2 * 3 * 4 and lone stars stay literal', () => {
    assert.equal(inner('use snake_case_name here'), '<p>use snake_case_name here</p>')
    assert.equal(inner('2 * 3 * 4'), '<p>2 * 3 * 4</p>')
    assert.equal(inner('**unclosed'), '<p>**unclosed</p>')
    assert.equal(inner('\\*literal\\*'), '<p>*literal*</p>')
  })
  it('paragraphs split on blank lines; single newlines are <br>', () => {
    assert.equal(inner('one\ntwo\n\nthree'), '<p>one<br/>two</p><p>three</p>')
  })
  it('fenced code blocks keep their text verbatim, language as a class', () => {
    assert.equal(inner('```ts\nconst a = 1 < 2 && **b**\n  indented\n```'), '<pre class="cf-md__pre"><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **b**\n  indented</code></pre>')
    assert.equal(inner('~~~\nx\n~~~'), '<pre class="cf-md__pre"><code>x</code></pre>')
    assert.equal(inner('```\nunterminated'), '<pre class="cf-md__pre"><code>unterminated</code></pre>')
    assert.equal(inner('````\n```\ninner\n```\n````'), '<pre class="cf-md__pre"><code>```\ninner\n```</code></pre>')
  })
  it('unordered and ordered lists, start number, nesting, inline markup in items', () => {
    assert.equal(inner('- one\n- **two**\n* other'), '<ul class="cf-md__list"><li>one</li><li><strong>two</strong></li></ul><ul class="cf-md__list"><li>other</li></ul>')
    assert.equal(inner('1. a\n2. b'), '<ol class="cf-md__list"><li>a</li><li>b</li></ol>')
    assert.equal(inner('3) c\n4) d'), '<ol class="cf-md__list" start="3"><li>c</li><li>d</li></ol>')
    assert.equal(inner('- a\n  - a1\n  - a2\n- b'), '<ul class="cf-md__list"><li><p>a</p><ul class="cf-md__list"><li>a1</li><li>a2</li></ul></li><li>b</li></ul>')
    assert.equal(inner('Steps:\n1. first\n2. second\n\nDone.'), '<p>Steps:</p><ol class="cf-md__list"><li>first</li><li>second</li></ol><p>Done.</p>')
  })
  it('links: http(s) and mailto, new tab, rel=noopener noreferrer', () => {
    assert.equal(inner('[docs](https://example.com/a?b=1)'), '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer" class="cf-md__a">docs</a></p>')
    assert.equal(inner('[*it*](http://example.com "title")'), '<p><a href="http://example.com/" target="_blank" rel="noopener noreferrer" class="cf-md__a"><em>it</em></a></p>')
    assert.equal(inner('[mail](mailto:charles@example.com)'), '<p><a href="mailto:charles@example.com" target="_blank" rel="noopener noreferrer" class="cf-md__a">mail</a></p>')
    assert.equal(inner('[wiki](https://en.wikipedia.org/wiki/Pier_(disambiguation))'), '<p><a href="https://en.wikipedia.org/wiki/Pier_(disambiguation)" target="_blank" rel="noopener noreferrer" class="cf-md__a">wiki</a></p>')
  })
  it('bare http(s) URLs autolink without trailing punctuation', () => {
    assert.equal(inner('See https://example.com/x.'), '<p>See <a href="https://example.com/x" target="_blank" rel="noopener noreferrer" class="cf-md__a">https://example.com/x</a>.</p>')
    assert.equal(inner('(https://example.com)'), '<p>(<a href="https://example.com/" target="_blank" rel="noopener noreferrer" class="cf-md__a">https://example.com</a>)</p>')
  })
  it('unsupported syntax stays literal text', () => {
    assert.equal(inner('# Heading\n> quote\n![img](https://x.test/a.png)'), '<p># Heading<br/>&gt; quote<br/>!<a href="https://x.test/a.png" target="_blank" rel="noopener noreferrer" class="cf-md__a">img</a></p>')
  })
})

describe('markdown: security (FE-9)', () => {
  it('<script> tags are text, never elements', () => {
    const out = html('hi <script>alert(1)</script> **x**\n\n<script src="https://evil.test/x.js"></script>')
    assert.ok(!/<script/i.test(out), out)
    assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assertOnlySafeMarkup(out)
  })
  it('raw HTML (img onerror, iframe, svg onload, style, a href) renders as escaped text', () => {
    const samples = [
      '<img src=x onerror="alert(1)">',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<svg/onload=alert(1)>',
      '<a href="javascript:alert(1)">click</a>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      '<b onmouseover="alert(1)">bold?</b>',
      '<details open ontoggle=alert(1)>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    ]
    for (const s of samples) {
      for (const md of [s, `- ${s}`, `**${s}**`, `[${s}](https://ok.test)`]) {
        const out = html(md)
        assertOnlySafeMarkup(out)
        assert.ok(!/<(img|iframe|svg|style|details|math|b)\b/i.test(out), out)
      }
    }
  })
  it('on* event attributes never appear on any element', () => {
    const md = '[x](https://ok.test" onclick="alert(1)) [y](https://ok.test onmouseover=alert(1)) <p onclick=alert(1)>p</p>'
    const out = html(md)
    assertOnlySafeMarkup(out)
    assert.ok(!/\son\w+=/i.test(out.replace(/>[^<]*</g, '><')), `no on* attribute: ${out}`)
  })
  it('javascript: links are refused in every disguise; the label stays as plain text', () => {
    const evil = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java script:alert(1)',
      'java\u0000script:alert(1)',
      'java\u200bscript:alert(1)',
      '\u0001javascript:alert(1)',
      'javascript&colon;alert(1)',
      '&#106;avascript:alert(1)',
      '&#x6A;avascript:alert(1)',
      '&#X6a;&#x61;&#x76;&#x61;script:alert(1)',
      '&#0000106&#0000097vascript:alert(1)',
      'jav&#x09;ascript:alert(1)',
      'jav&Tab;ascript:alert(1)',
      'java&NewLine;script:alert(1)',
      '&amp;#106;avascript:alert(1)',
      '%6Aavascript:alert(1)',
      '<javascript:alert(1)>',
      'javascript://%0aalert(1)',
      'javascript:http://example.com',
    ]
    for (const href of evil) {
      assert.equal(safeHref(href), null, JSON.stringify(href))
      const out = html(`[click me](${href})`)
      assert.ok(!/<a\b/.test(out), `${JSON.stringify(href)} -> ${out}`)
      assert.match(out, /click me/)
      assertOnlySafeMarkup(out)
    }
  })
  it('data:, vbscript:, file: and other schemes are refused', () => {
    for (const href of ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'DATA:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'VBScript:msgbox(1)', 'vb&#115;cript:msgbox(1)', 'file:///etc/passwd', 'ftp://example.com', 'blob:https://x', 'tel:123', 'about:blank']) {
      assert.equal(safeHref(href), null, href)
      assert.ok(!/<a\b/.test(html(`[x](${href})`)), href)
    }
  })
  it('relative, protocol-relative and host-less URLs are refused', () => {
    for (const href of ['/api/agents', '//evil.test/x', 'evil.test', '#top', 'https://', 'http:/x', 'mailto:']) assert.equal(safeHref(href), null, href)
  })
  it('allowed hrefs are normalised and cannot break out of the attribute', () => {
    assert.equal(safeHref('HTTPS://Example.com/a b'), 'https://example.com/ab')
    assert.equal(safeHref('https://ok.test/"><script>'), 'https://ok.test/%22%3E%3Cscript%3E')
    assert.equal(safeHref('mailto:a@b.test"onmouseover=x'), null)
    const out = html('[x](https://ok.test/"onmouseover="alert(1))')
    assertOnlySafeMarkup(out)
  })
  it('a bare javascript: URL is never autolinked', () => {
    const out = html('javascript:alert(1) and data:text/html,x')
    assert.ok(!/<a\b/.test(out))
  })
  it('pathological input: deep nesting and huge input stay bounded', () => {
    const deep = '*'.repeat(2000) + 'x' + '*'.repeat(2000)
    assertOnlySafeMarkup(html(deep))
    const nested = Array.from({ length: 50 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n')
    assertOnlySafeMarkup(html(nested))
    const brackets = '['.repeat(5000) + '](' + ')'.repeat(5000)
    const t = Date.now()
    assertOnlySafeMarkup(html(brackets))
    assert.ok(Date.now() - t < 2000, 'brackets parse quickly')
    for (const md of ['_a '.repeat(20000), '*a '.repeat(20000), '['.repeat(30000), '[a]('.repeat(10000), '**[`*_'.repeat(8000)]) {
      const t0 = Date.now()
      parseMarkdown(md)
      assert.ok(Date.now() - t0 < 1500, `linear-ish on ${md.slice(0, 6)}…`)
    }
    assert.equal(parseMarkdown('a'.repeat(100_001)).length, 1)
  })
  it('no dangerouslySetInnerHTML / innerHTML in the markdown path or the chat page', () => {
    for (const f of ['../src/lib/markdown.ts', '../src/lib/markdown-render.ts', '../src/components/Markdown.tsx', '../src/pages/ConversationChat.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(src), f)
    }
  })
  it('no component in src renders raw HTML', () => {
    const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}${d.name}/`) : [`${dir}${d.name}`]))
    for (const f of walk('../src/').filter((f) => /\.(tsx?|mjs)$/.test(f))) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      assert.ok(!/dangerouslySetInnerHTML/.test(src), f)
    }
  })
})
