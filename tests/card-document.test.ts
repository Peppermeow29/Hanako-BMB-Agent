import { describe, expect, it } from "vitest";
import { buildCardDocument } from "../server/cards/card-document.ts";

describe("buildCardDocument", () => {
  it("injects the agent code verbatim into the body", () => {
    const code = '<button id="go" onclick="alert(1)">开始</button>';
    const html = buildCardDocument({ code });
    expect(html).toContain(code);
  });

  it("injects collected theme vars into :root", () => {
    const varsCss = "  --accent: #537D96;\n  --bg-card: #FCFAF5;";
    const html = buildCardDocument({ code: "<div>x</div>", varsCss });
    expect(html).toContain("--accent: #537D96;");
    expect(html).toContain("--bg-card: #FCFAF5;");
  });

  it("always defines the serif/ui/mono font stacks even without vars", () => {
    const html = buildCardDocument({ code: "<div>x</div>" });
    expect(html).toContain("--font-serif:");
    expect(html).toContain("--font-mono:");
  });

  it("hides the iframe viewport scrollbar while keeping the document scrollable", () => {
    const html = buildCardDocument({ code: "<div>x</div>" });
    expect(html).toMatch(/html\s*\{[^}]*scrollbar-width:\s*none;[^}]*-ms-overflow-style:\s*none;/);
    expect(html).toMatch(/html::-webkit-scrollbar,\s*body::-webkit-scrollbar\s*\{[^}]*width:\s*0;[^}]*height:\s*0;/);
  });

  it("embeds the height-report script and ping handler so scripts drive resize", () => {
    const html = buildCardDocument({ code: "<div>x</div>" });
    expect(html).toContain("hana.card-resize");
    expect(html).toContain("hana.card-ping");
    expect(html).toContain("ResizeObserver");
  });

  it("sanitizes angle brackets in varsCss so no tag can be injected", () => {
    const malicious = "--x: 1;</style><script>steal()</script>";
    const html = buildCardDocument({ code: "<div>x</div>", varsCss: malicious });
    const head = html.slice(0, html.indexOf("</head>"));
    // 尖括号被剥光 → 注入串无法闭合 style，也无法生成 <script>。
    // head 内只应存在那个合法的 </style> 收尾，且没有任何 <script。
    expect(head.match(/<\/style>/g)?.length).toBe(1);
    expect(head).not.toContain("<script");
  });

  it("produces a complete standalone HTML document", () => {
    const html = buildCardDocument({ code: "<div>x</div>" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<body>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });
});
