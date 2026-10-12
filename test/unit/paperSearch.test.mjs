/**
 * 论文检索与全文获取的**纯逻辑**。
 *
 * ## 这一层为什么值得单测
 *
 * 检索结果的解析、候选排序、PDF 判定，全部是"看着对、错了也看不出来"的东西：
 *
 *  - DOI 少剥一层前缀 → Content Negotiation 404，而**404 看起来像"这篇不存在"**；
 *  - Crossref 的摘要带 JATS 标签 → 建条目后 `abstractNote` 里全是 `<jats:p>`；
 *  - 排序把预印本排在正式版前面 → 用户库里多一篇错的；
 *  - 把跳转页 HTML 当成 PDF 存下来 → 附件点开是网页，比"没拿到全文"难清理得多。
 *
 * 这些都不会让构建失败，所以只能靠这里钉住。
 *
 * 真实网络请求不在这里测（那属于集成测试）：`paperFetch.ts` 的 HTTP 调用
 * 在真机上验证，本文件只覆盖 `paperSearch.ts` 的纯函数。
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const {
  normalizeDoi,
  looksLikeDoi,
  doiUrl,
  buildCrossrefSearch,
  validatePaperQuery,
  parseCrossrefItems,
  stripJats,
  pickOpenAccessPdf,
  isPlausiblePdfUrl,
  looksPaywalled,
  rankCandidates,
  formatCandidates,
  PAPER_NEXT_STEP_HINT,
  isPdfBytes,
  itemTypeFromDataCite,
  parseDataCite,
} = bundle;

describe("DOI 规整（少剥一层就会 404，而 404 看起来像「这篇不存在」）", function () {
  it("剥掉各种前缀与外壳", function () {
    const want = "10.1145/3290605.3300233";
    for (const raw of [
      "10.1145/3290605.3300233",
      "doi:10.1145/3290605.3300233",
      "DOI: 10.1145/3290605.3300233",
      "https://doi.org/10.1145/3290605.3300233",
      "http://dx.doi.org/10.1145/3290605.3300233",
      "  10.1145/3290605.3300233  ",
    ]) {
      assert.equal(normalizeDoi(raw), want, `未能规整：${raw}`);
    }
  });

  it("剥掉**句末标点**（模型常在句子里带出来）", function () {
    assert.equal(
      normalizeDoi("10.1145/3290605.3300233."),
      "10.1145/3290605.3300233",
    );
    assert.equal(
      normalizeDoi("10.1145/3290605.3300233。"),
      "10.1145/3290605.3300233",
    );
  });

  it("空输入返回 undefined，而不是空串（否则会发一个注定失败的请求）", function () {
    assert.equal(normalizeDoi(""), undefined);
    assert.equal(normalizeDoi("   "), undefined);
    assert.equal(normalizeDoi(undefined), undefined);
    assert.equal(normalizeDoi("doi:"), undefined);
  });

  it("形状校验只认 DOI 手册的形态", function () {
    assert.ok(looksLikeDoi("10.1145/3290605.3300233"));
    assert.ok(looksLikeDoi("10.1000/xyz"));
    assert.ok(!looksLikeDoi("arxiv:2301.00001"), "arXiv id 不是 DOI");
    assert.ok(!looksLikeDoi("10.1145"), "缺斜杠后缀");
    assert.ok(!looksLikeDoi("doi:10.1/x"), "注册机构号不足 4 位");
  });

  it("doiUrl 产出可点击地址", function () {
    assert.equal(
      doiUrl("10.1145/x"),
      "https://doi.org/10.1145/x",
      "条目 url 字段与给用户看的链接都用它",
    );
  });
});

describe("Crossref 检索式", function () {
  it("有标题/作者时用**字段限定**查询（比自由文本准得多）", function () {
    const f = buildCrossrefSearch({ title: "Attention Is All You Need" });
    assert.equal(f["query.title"], "Attention Is All You Need");
    assert.equal(
      f["query.bibliographic"],
      undefined,
      "只给标题时不该退化成最宽的自由文本查询",
    );
    const g = buildCrossrefSearch({ author: "Vaswani" });
    assert.equal(g["query.author"], "Vaswani");
  });

  it("只有自由文本时才用 bibliographic 兜底", function () {
    const f = buildCrossrefSearch({ query: "transformer 综述" });
    assert.equal(f["query.bibliographic"], "transformer 综述");
  });

  it("年份转成日期区间 filter", function () {
    const f = buildCrossrefSearch({ title: "x", year: 2023 });
    assert.match(f.filter ?? "", /from-pub-date:2023-01-01/);
    assert.match(f.filter ?? "", /until-pub-date:2023-12-31/);
  });

  it("rows 夹在 1..50（避免模型传个 1000 把接口拖垮）", function () {
    assert.equal(buildCrossrefSearch({ query: "x", limit: 1000 }).rows, 50);
    assert.equal(buildCrossrefSearch({ query: "x", limit: 0 }).rows, 1);
    assert.equal(buildCrossrefSearch({ query: "x" }).rows, 10, "默认 10");
  });

  it("validatePaperQuery 要求至少一个条件，并明确点名 DOI 优先", function () {
    assert.ok(validatePaperQuery({}));
    assert.equal(validatePaperQuery({ doi: "10.1/x" }), undefined);
    assert.equal(validatePaperQuery({ title: "x" }), undefined);
    assert.match(validatePaperQuery({}) ?? "", /doi/);
    assert.match(validatePaperQuery({ title: "x", year: 99 }) ?? "", /year/);
  });
});

describe("Crossref 响应解析", function () {
  const payload = {
    message: {
      items: [
        {
          DOI: "10.1145/3290605.3300233",
          title: ["A Study of X"],
          author: [{ given: "Ada", family: "Lovelace" }, { name: "某机构" }],
          issued: { "date-parts": [[2023, 5, 1]] },
          "container-title": ["CHI"],
          URL: "https://doi.org/10.1145/3290605.3300233",
          abstract: "<jats:p>We study <jats:italic>X</jats:italic>.</jats:p>",
          score: 12.5,
        },
        { title: ["没有 DOI 的条目"] },
        { DOI: "10.1/x" }, // 没有标题 —— 建条目没用，应被丢掉
      ],
    },
  };

  it("取到标题/作者/年份/期刊/DOI/摘要", function () {
    const out = parseCrossrefItems(payload);
    assert.equal(out.length, 2, "没有标题的那条应被丢掉（建条目必须有标题）");
    const first = out[0];
    assert.equal(first.title, "A Study of X");
    assert.deepEqual(first.authors, ["Ada Lovelace", "某机构"]);
    assert.equal(first.year, 2023);
    assert.equal(first.venue, "CHI");
    assert.equal(first.doi, "10.1145/3290605.3300233");
    assert.equal(first.source, "crossref");
  });

  it("摘要里的 JATS 标签会被剥掉（否则 abstractNote 里全是标签）", function () {
    const out = parseCrossrefItems(payload);
    assert.equal(out[0].abstract, "We study X.");
    assert.ok(!out[0].abstract.includes("<"), "不能留下任何标签");
  });

  it("分数被保留（模型据此比较候选，而不是盲选第一条）", function () {
    const out = parseCrossrefItems(payload);
    assert.equal(out[0].score, 12.5);
  });

  it("结构不对时返回空数组而不是抛错", function () {
    for (const bad of [
      null,
      {},
      { message: {} },
      { message: { items: "x" } },
    ]) {
      assert.deepEqual(parseCrossrefItems(bad), []);
    }
  });

  it("stripJats 处理实体与多余空白", function () {
    assert.equal(
      stripJats("<p>A &amp; B</p>\n\n  <b>C</b>"),
      "A & B C",
      "换行与多余空格要压成一个空格",
    );
    assert.equal(stripJats(""), undefined);
    assert.equal(stripJats(undefined), undefined);
  });

  it("行内标签不留多余空格，块级标签不粘连", function () {
    // 真机缺陷：标签替换成空格会让 `X</i>.` 变成 `X .`（句号前多一个空格），
    // 而它会**真的进到条目的 abstractNote 里**。
    assert.equal(
      stripJats("<jats:p>We study <jats:italic>X</jats:italic>.</jats:p>"),
      "We study X.",
      "行内标签不能留下多余空格",
    );
    // 反过来：块级标签必须给空格，否则两个段落会粘成一个词
    assert.equal(
      stripJats("<jats:p>First.</jats:p><jats:p>Second.</jats:p>"),
      "First. Second.",
      "相邻段落不能粘成 First.Second.",
    );
    assert.equal(stripJats("<p>a</p><br/><p>b</p>"), "a b");
    assert.equal(stripJats("&nbsp;x&nbsp;"), "x", "&nbsp; 也要处理");
  });
});

describe("DataCite 解析（arXiv / Zenodo / 机构库的 DOI 在这里）", function () {
  /** 真实响应的形状（取自 api.datacite.org 对 10.48550/arXiv.1706.03762 的返回） */
  const payload = {
    data: {
      attributes: {
        doi: "10.48550/arxiv.1706.03762",
        titles: [{ title: "Attention Is All You Need" }],
        creators: [
          {
            givenName: "Ashish",
            familyName: "Vaswani",
            name: "Vaswani, Ashish",
          },
          { givenName: "Noam", familyName: "Shazeer", name: "Shazeer, Noam" },
          { name: "某机构作者" },
        ],
        publicationYear: 2017,
        publisher: "arXiv",
        container: {},
        url: "https://arxiv.org/abs/1706.03762",
        // ⚠️ 第一个 description **不是**摘要 —— 真实数据里就是这个顺序
        descriptions: [
          { description: "15 pages, 5 figures", descriptionType: "Other" },
          {
            description: "<p>The dominant sequence transduction models…</p>",
            descriptionType: "Abstract",
          },
        ],
        // DataCite 明确给出资源类型，据此可把预印本建成 preprint
        types: { resourceTypeGeneral: "Preprint", resourceType: "Article" },
      },
    },
  };

  it("取到标题/作者/年份/DOI/URL", function () {
    const c = parseDataCite(payload);
    assert.ok(c, "应解析成功");
    assert.equal(c.title, "Attention Is All You Need");
    assert.deepEqual(c.authors, [
      "Ashish Vaswani",
      "Noam Shazeer",
      "某机构作者",
    ]);
    assert.equal(c.year, 2017);
    assert.equal(c.doi, "10.48550/arxiv.1706.03762");
    assert.equal(c.url, "https://arxiv.org/abs/1706.03762");
    assert.equal(c.source, "datacite");
  });

  it("**按 descriptionType 取摘要**，不能拿第一个 description", function () {
    // 真实数据里第一个是 "15 pages, 5 figures"（Other）——
    // 直接取第一个会把篇幅说明当摘要写进条目。
    const c = parseDataCite(payload);
    assert.match(c.abstract ?? "", /dominant sequence transduction/);
    assert.ok(
      !/15 pages/.test(c.abstract ?? ""),
      "不能把 Other 类型的 description 当摘要",
    );
  });

  it("预印本没有 container 时用 publisher 顶上（否则界面缺一块）", function () {
    const c = parseDataCite(payload);
    assert.equal(c.venue, "arXiv");
    const withContainer = parseDataCite({
      data: {
        attributes: {
          ...payload.data.attributes,
          container: { title: "NeurIPS" },
        },
      },
    });
    assert.equal(withContainer.venue, "NeurIPS");
  });

  it("结构不对时返回 undefined 而不是抛错", function () {
    for (const bad of [null, {}, { data: {} }, { data: { attributes: {} } }]) {
      assert.equal(parseDataCite(bad), undefined);
    }
  });

  it("resourceTypeGeneral 映射成 Zotero 条目类型", function () {
    // 不映射的话 arXiv 预印本会被建成 journalArticle（默认值），
    // 而两者字段表不同 —— 真机上正是 preprint 才撞出字段校验错。
    assert.equal(itemTypeFromDataCite(payload), "preprint");
    assert.equal(
      itemTypeFromDataCite({
        data: {
          attributes: { types: { resourceTypeGeneral: "JournalArticle" } },
        },
      }),
      "journalArticle",
    );
    assert.equal(
      itemTypeFromDataCite({
        data: { attributes: { types: { resourceTypeGeneral: "Dataset" } } },
      }),
      "document",
    );
    assert.equal(
      itemTypeFromDataCite({
        data: { attributes: { types: { resourceTypeGeneral: "未知类型" } } },
      }),
      undefined,
      "不认识的类型应返回 undefined，由调用方回退到默认",
    );
    assert.equal(itemTypeFromDataCite(null), undefined);
  });
});

describe("同一论文的多个 DOI 登记（真机上选错了一条）", function () {
  it("下一步指引必须警告不要只看排序或有无 PDF", function () {
    // 真机：arXiv 的 DOI 查不到（注册在 DataCite），模型于是从近似结果里
    // 挑了一条 2025 年的第三方重复登记，DOI 与年份都错了，
    // 而标题作者看起来完全正常 —— 错元数据因此进了用户库。
    assert.match(
      PAPER_NEXT_STEP_HINT,
      /多个 DOI 登记|不要仅因为/,
      "必须警告「可能有多条登记，别只看排序或有无 PDF」",
    );
    assert.match(PAPER_NEXT_STEP_HINT, /年份与作者/);
    assert.match(PAPER_NEXT_STEP_HINT, /itemType/, "要提示填建议的条目类型");
  });

  it("结果文本里会显示「建议条目类型」", function () {
    const text = formatCandidates([
      { title: "X", doi: "10.1/x", itemType: "preprint" },
    ]);
    assert.match(text, /建议条目类型: preprint/);
  });
});

describe("PDF URL 判定（保守：宁可漏，也不要把网页存成附件）", function () {
  it("接受明显的 PDF 地址", function () {
    for (const url of [
      "https://arxiv.org/pdf/2301.00001",
      "https://example.org/paper.pdf",
      "https://example.org/article-pdf/10.1/x",
      "https://example.org/epdf/10.1/x",
      "https://example.org/download?type=pdf",
    ]) {
      assert.ok(isPlausiblePdfUrl(url), `应接受 ${url}`);
    }
  });

  it("拒绝网页地址（把它当 PDF 存下来会让附件点开是网页）", function () {
    for (const url of [
      "https://example.org/article/10.1/x",
      "https://example.org/landing",
      "ftp://example.org/x.pdf",
      "not-a-url",
    ]) {
      assert.ok(!isPlausiblePdfUrl(url), `应拒绝 ${url}`);
    }
  });

  it("识别常见出版社（用于给出一句提示，不是拦截）", function () {
    assert.ok(
      looksPaywalled("https://www.sciencedirect.com/science/article/pii/X"),
    );
    assert.ok(looksPaywalled("https://dl.acm.org/doi/10.1145/x"));
    assert.ok(!looksPaywalled("https://arxiv.org/pdf/2301.00001"));
    assert.ok(!looksPaywalled("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/"));
  });

  it("PDF 魔术字节：接受 %PDF-，拒绝 HTML", function () {
    const pdf = new TextEncoder().encode("%PDF-1.7\n...");
    assert.ok(isPdfBytes(pdf));
    // 前面有空白/BOM 也要认
    assert.ok(isPdfBytes(new TextEncoder().encode("\n  %PDF-1.4")));
    const html = new TextEncoder().encode("<!DOCTYPE html><html>");
    assert.ok(!isPdfBytes(html), "HTML 绝不能被当成 PDF —— 这是最要紧的一条");
    assert.ok(!isPdfBytes(new Uint8Array(0)));
  });
});

describe("开放获取 PDF 提取", function () {
  it("优先 best_oa_location，其次 primary，再其次 locations", function () {
    assert.equal(
      pickOpenAccessPdf({ best_oa_location: { pdf_url: "https://a/x.pdf" } }),
      "https://a/x.pdf",
    );
    assert.equal(
      pickOpenAccessPdf({ primary_location: { pdf_url: "https://b/x.pdf" } }),
      "https://b/x.pdf",
    );
    assert.equal(
      pickOpenAccessPdf({
        locations: [{ pdf_url: null }, { pdf_url: "https://c/x.pdf" }],
      }),
      "https://c/x.pdf",
    );
  });

  it("**跳过** landing_page_url（那是网页，不是 PDF）", function () {
    const out = pickOpenAccessPdf({
      best_oa_location: { landing_page_url: "https://a/landing" },
      open_access: { oa_url: "https://a/landing" },
    });
    assert.equal(
      out,
      undefined,
      "只有落地页时应当返回 undefined，而不是把它当 PDF",
    );
  });

  it("什么都没有时返回 undefined（不是错误）", function () {
    assert.equal(pickOpenAccessPdf({}), undefined);
    assert.equal(pickOpenAccessPdf(null), undefined);
  });
});

describe("候选排序（建错条目比建不出来更难清理）", function () {
  const query = { title: "Attention Is All You Need", year: 2017 };

  it("DOI 完全命中排第一", function () {
    const list = [
      { title: "Something Else", doi: "10.1/other" },
      { title: "Whatever", doi: "10.1/WANT" },
    ];
    const ranked = rankCandidates(list, { ...query, doi: "10.1/want" });
    assert.equal(
      ranked[0].doi,
      "10.1/WANT",
      "DOI 命中是最强信号（大小写不敏感）",
    );
  });

  it("标题词重合度高的优先（把综述/引用它的文章压下去）", function () {
    const ranked = rankCandidates(
      [
        { title: "A Survey of Attention Mechanisms" },
        { title: "Attention Is All You Need" },
      ],
      query,
    );
    assert.equal(ranked[0].title, "Attention Is All You Need");
  });

  it("年份接近的优先", function () {
    const ranked = rankCandidates(
      [
        { title: "Attention Is All You Need", year: 2024 },
        { title: "Attention Is All You Need", year: 2017 },
      ],
      query,
    );
    assert.equal(ranked[0].year, 2017);
  });

  it("不改动原数组（调用方可能还要用原顺序）", function () {
    const list = [{ title: "b" }, { title: "a" }];
    const copy = [...list];
    rankCandidates(list, query);
    assert.deepEqual(list, copy, "排序必须返回新数组，不能原地改");
  });
});

describe("结果的呈现（这是模型实际读到的东西）", function () {
  it("每条都给全 DOI 与标题 —— 少了 DOI 模型就会去猜或去 web search", function () {
    const text = formatCandidates([
      {
        title: "Attention Is All You Need",
        authors: [
          "Ashish Vaswani",
          "Noam Shazeer",
          "Niki Parmar",
          "Jakob Uszkoreit",
        ],
        year: 2017,
        venue: "NeurIPS",
        doi: "10.48550/arXiv.1706.03762",
      },
    ]);
    assert.match(text, /Attention Is All You Need/);
    assert.match(text, /DOI: 10\.48550\/arXiv\.1706\.03762/);
    assert.match(text, /2017/);
    assert.match(text, /NeurIPS/);
    assert.match(text, /等 4 位/, "作者多时应折叠，否则一条候选就占掉大半屏");
  });

  it("零结果时给出**可操作的下一步**，而不是只说「没找到」", function () {
    const text = formatCandidates([]);
    assert.match(text, /没有检索到/);
    assert.match(text, /标题片段|作者|年份/, "要提示怎么放宽条件");
    assert.match(
      text,
      /`search`/,
      "要提示可以先在本地文库找 —— 可能已经收录了",
    );
  });

  it("下一步指引必须明确否掉 web search 并说明原因", function () {
    assert.match(PAPER_NEXT_STEP_HINT, /createItem/);
    assert.match(PAPER_NEXT_STEP_HINT, /pdfUrl/);
    assert.match(
      PAPER_NEXT_STEP_HINT,
      /不要用 web search/,
      "不写清这一点，模型会退回它熟悉的 web search —— 那条路看不见机构订阅",
    );
    assert.match(PAPER_NEXT_STEP_HINT, /机构/, "要说明原因，否则模型不会照做");
  });
});
