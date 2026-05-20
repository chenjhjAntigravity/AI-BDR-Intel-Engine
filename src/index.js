import { Buffer } from 'node:buffer';
import PostalMime from 'postal-mime';

/**
 * BDR Intel Cloud Node v3.5.7 (Full Intel + Auto-Discovery + Local Bridge Integration)
 */

/**
 * 调用本地 Bridge 进行深度扫描（fire-and-forget）
 * @param {string} company
 * @param {string} domain
 * @param {object} env
 */
async function callBridge(company, domain, env) {
  if (!env.BRIDGE_URL) return;
  const token = env.BRIDGE_TOKEN || 'antigravity-bdr-secret-token';
  try {
    const res = await fetch(`${env.BRIDGE_URL}/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ company, domain }),
      signal: AbortSignal.timeout(8000)
    });
    console.log(`[Bridge] 触发深度扫描: ${company} (${domain}) => ${res.status}`);
  } catch (e) {
    console.warn(`[Bridge] 连接失败: ${e.message}`);
  }
}

async function takeScreenshot(url, env) {
  if (!env.BROWSER) return null;
  let browser = null;
  try {
    browser = await env.BROWSER.launch();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
    await browser.close();
    return screenshot;
  } catch (e) {
    if (browser) await browser.close();
    return null;
  }
}

async function saveScreenshotToR2(domain, screenshot, env) {
  if (!env.REPORTS_BUCKET || !screenshot) return null;
  const key = `screenshots/${domain}.jpg`;
  try {
    await env.REPORTS_BUCKET.put(key, screenshot, {
      httpMetadata: { contentType: 'image/jpeg' }
    });
    return `/screenshot?domain=${domain}`;
  } catch (e) {
    console.error("R2 Upload Error:", e);
    return null;
  }
}

// ── 辅助: 名称相似度简单检测 ──
// 提取关键词（中文字符/英文单词），看 Apollo 返回的英文名是否包含输入公司名的关键部分

// 🔒 高权重知名公司域名黑名单：永不自动分配给无关的搜索结果
const DOMAIN_BLACKLIST = new Set([
  "huawei.com", "xiaomi.com", "alibaba.com", "tencent.com", "jd.com",
  "baidu.com", "bytedance.com", "meituan.com", "pinduoduo.com", "netease.com",
  "weibo.com", "didi.com", "lenovo.com", "haier.com", "hisense.com",
  "oppo.com", "vivo.com", "oneplus.com", "meizu.com", "zte.com.cn",
  "hikvision.com", "dahuasecurity.com", "byd.com", "geely.com", "chery.com"
]);

function nameSimilarityCheck(inputName, apolloOrgName) {
  if (!inputName || !apolloOrgName) return false;
  const input = inputName.toLowerCase();
  const apollo = apolloOrgName.toLowerCase();
  // 提取输入名中所有英文词（>= 3 字母）
  const inputWords = input.match(/[a-z]{3,}/g) || [];
  // 如果输入有英文词，看 Apollo 名是否包含其中之一
  if (inputWords.length > 0) {
    return inputWords.some(w => apollo.includes(w));
  }
  // 🔑 修复: 纯中文输入时，不再盲目 return true
  // 策略：去除通用词后，检查中文关键词是否出现在 Apollo 公司名（全小写）中
  // （部分公司 Apollo 名含中文，如 "Huawei Technologies 华为技术"）
  const genericCN = /(科技|技术|集团|有限公司|股份|责任|公司|控股|网络|信息|数字|智能|软件|系统|电子|通信|实业|商业|传媒|文化|教育|医疗|金融|资本|投资|国际|全球|中国|深圳|广州|北京|上海|成都|杭州|武汉|西安)/g;
  const coreKeyword = input.replace(genericCN, "").trim();
  if (coreKeyword.length >= 2) {
    // Apollo 名含有该中文关键字则认为匹配
    return apollo.includes(coreKeyword);
  }
  // 关键词太短或全部被过滤掉（如「XX科技」→""），降级为 false，交由 DeepSeek 兜底
  return false;
}

async function runOSINT(company, inDomain, env) {
  let domain = (inDomain || "").trim().toLowerCase();
  let domainConfidence = 'high'; // 'high' | 'medium' | 'low'
  let domainSource = '手动输入';
  const cLower = (company || "").toLowerCase();
  if (cLower.includes("cogolinks") || cLower.includes("行云数字")) {
    domain = "cogolinks.com";
  }

  // ── 阶段 1: Apollo 官方组织库搜索 ──
  // 🔑 修复: 新增 organization_locations 中国过滤 + 名称相似度校验
  if (!domain && company && env.APOLLO_API_KEY) {
    try {
      const apolloSearch = await fetch("https://api.apollo.io/api/v1/organizations/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": env.APOLLO_API_KEY },
        body: JSON.stringify({
          q_organization_name: company,
          // 🔑 只搜索中国公司，直接排除印度/外国同名企业
          organization_locations: ["China"],
          per_page: 3
        })
      });
      if (apolloSearch.ok) {
        const res = await apolloSearch.json();
        const orgs = res.organizations || [];
        
        for (const org of orgs.slice(0, 3)) {
          const matchedDomain = org.primary_domain?.toLowerCase();
          // 🔑 修复: 扩展黑名单过滤，防止华为等头部企业域名被误分配
          if (!matchedDomain || DOMAIN_BLACKLIST.has(matchedDomain)) {
            console.warn(`⛔ 域名黑名单过滤: ${matchedDomain} — 跳过`);
            continue;
          }
          
          // 🔑 名称相似度检测：确保 Apollo 返回的公司名与输入相关
          const nameOk = nameSimilarityCheck(company, org.name || '');
          if (!nameOk) {
            console.warn(`⚠️ 名称不匹配: 输入"${company}" vs Apollo"${org.name}"(${matchedDomain}) — 跳过`);
            continue;
          }
          
          // DNS 存活校验
          try {
            const dns = await fetch(`https://cloudflare-dns.com/dns-query?name=${matchedDomain}&type=A`, { 
              headers: { "Accept": "application/dns-json" } 
            }).then(r => r.json());
            
            if (dns.Answer && dns.Answer.length > 0) {
              domain = matchedDomain;
              domainConfidence = nameOk ? 'high' : 'medium';
              domainSource = `Apollo [${org.name}]`;
              console.log(`✅ Live Domain Found via Apollo (CN filtered): ${domain}`);
              break; 
            }
          } catch(e) {}
        }
      }
    } catch(e) { console.error("Apollo Search Error:", e); }
  }

  // ── 阶段 2: 如果 Apollo 没搜到，用 AI 推测（高可用 fallback） ──
  if (!domain && company && (env.DEEPSEEK_API_KEY || env.AI)) {
    try {
      const content = await callAI(env, [
        { role: "system", content: "You are a precise intelligence assistant for a China-focused BDR team. Given a Chinese company name, return ONLY the official root domain of that CHINESE MAINLAND company (e.g. bonc.com.cn, xtalpi.com). If this is clearly a foreign company or you cannot determine a China-based domain with confidence, return exactly: unknown. NO explanations, NO extra text." },
        { role: "user", content: company }
      ]);
      let guess = content.trim().toLowerCase();
      guess = guess.replace(/[!"#$%&'()*+,:;<=>?@\[\]^`{|}~]/g, "").split("\n")[0].split(" ")[0];
      if (guess !== 'unknown' && guess.includes('.')) {
        domain = guess;
        domainConfidence = 'low';
        domainSource = 'AI推测';
      }
    } catch(e) { console.error("AI Domain Guess Error:", e); }
  }

  if (!domain) throw new Error(`未能在数据库中找到 "${company}" 的官方域名。建议手动输入域名（如: xtalpi.com）进行探测。`);

  // ── 阶段 3: 强制 DNS 存活校验 ──
  if (domain) {
    try {
      const dnsCheck = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A`, { 
        headers: { "Accept": "application/dns-json" } 
      }).then(r => r.json());
      if (!dnsCheck.Answer || dnsCheck.Answer.length === 0) {
        // 如果 A 记录不存在，尝试加 www 前缀或 .cn 变体 (此处可扩展)
        console.warn(`Domain ${domain} has no A record. Flagging as suspicious.`);
      }
    } catch(e) {}
  }

  if (!domain) throw new Error("无法锁定目标域名，请输入域名或正确的公司名称。");

  // 如果只有域名没有公司名，用域名作为显示名称
  const displayName = company || domain;

  // 并行全量数据采集
  let [dnsData, httpData, crtData, bwData, apolloOrgData, contactData, maimaiData, screenshot] = await Promise.all([
    // 1. DNS 解析 (A记录 + MX记录 + CNAME 多维探测)
    (async () => {
      const [aRec, mxRec, cnameRec] = await Promise.all([
        fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A`, { headers: { "Accept": "application/dns-json" } }).then(r=>r.json()).catch(()=>({})),
        fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=MX`, { headers: { "Accept": "application/dns-json" } }).then(r=>r.json()).catch(()=>({})),
        fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=CNAME`, { headers: { "Accept": "application/dns-json" } }).then(r=>r.json()).catch(()=>({}))
      ]);
      const ips = (aRec.Answer || []).map(a => a.data).join(", ") || "Unresolved";
      const mx = (mxRec.Answer || []).map(a => a.data).join(", ") || "";
      const cname = (cnameRec.Answer || []).map(a => a.data).join(", ") || "";
      // 从 MX/CNAME 推断邮件服务商和 CDN
      let emailProvider = "Unknown";
      if (mx.includes("google")) emailProvider = "Google Workspace";
      else if (mx.includes("outlook") || mx.includes("microsoft")) emailProvider = "Microsoft 365";
      else if (mx.includes("mxbiz") || mx.includes("qiye.aliyun")) emailProvider = "阿里邮箱";
      else if (mx.includes("qqmail") || mx.includes("exmail.qq")) emailProvider = "腾讯企业邮";
      return { ips, mx, cname, emailProvider };
    })(),
    // 2. HTTP 头检测 (CF Proxy + CF Zero Trust)
    (async () => {
      try {
        const res = await fetch(`https://${domain}`, { redirect: "follow", headers: { 'User-Agent': 'Mozilla/5.0' } });
        const s = res.headers.get("server") || "Unknown";
        const allHeaders = [...res.headers.keys()].join(",").toLowerCase();
        const status = res.status;
        
        // 增强版 WAF 签名库 (排除 5xx 报错页产生的假阳性)
        const isErrorPage = status >= 500;
        const signatures = {
          cfProxy: !isErrorPage && (allHeaders.includes("cf-ray") || s.toLowerCase().includes("cloudflare")),
          cfTeam: allHeaders.includes("cf-access") || allHeaders.includes("cf-team"),
          akamai: allHeaders.includes("akamai") || allHeaders.includes("x-akamai-edgescape"),
          imperva: allHeaders.includes("x-iinfo") || allHeaders.includes("incap-res"),
          fastly: allHeaders.includes("x-fastly"),
          awsWaf: allHeaders.includes("awselb") || allHeaders.includes("x-amz-cf-id"),
          fortinet: allHeaders.includes("fortigate"),
          f5: allHeaders.includes("f5-traffic") || allHeaders.includes("bigip") || allHeaders.includes("x-wa-info")
        };

        // 安全合规审计 (Security Maturity)
        const securityMaturity = {
          hsts: allHeaders.includes("strict-transport-security"),
          csp: allHeaders.includes("content-security-policy"),
          xFrame: allHeaders.includes("x-frame-options")
        };

        return { status, server: s, cfProxy: signatures.cfProxy, cfTeam: signatures.cfTeam, signatures, securityMaturity };
      } catch(e) { return { status: "Error", server: "Unknown", cfProxy: false, cfTeam: false, signatures: {}, securityMaturity: {} }; }
    })(),
    // 3. crt.sh 子域名打捞 (易超时，限制 5 秒)
    fetch(`https://crt.sh/?q=%.${domain}&output=json`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(j => {
        const n = new Set();
        j.forEach(r => r.name_value.split('\n').forEach(v => { if (!v.startsWith('*.')) n.add(v.toLowerCase()); }));
        const list = Array.from(n).filter(v => v.includes(domain));
        return { total: list.length, sensitive: list.filter(s => /vpn|jira|confluence|gitlab|dev|staging|portal|admin|sso|login|api/.test(s)).slice(0, 10) };
      }).catch(() => ({ total: 0, sensitive: [] })),
    // 4. BuiltWith 技术栈全量检测（安全/CDN/框架/云厂商）
    (async () => {
      try {
        const t = await fetch(`https://builtwith.com/detailed/${domain}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }).then(r=>r.text());
        const security = ["Akamai", "Fastly", "CloudFront", "F5", "Incapsula", "Imperva", "Fortinet", "Palo Alto", "Zscaler"].filter(c => t.includes(c));
        const framework = ["React", "Vue", "Angular", "Next.js", "WordPress", "Shopify", "Salesforce"].filter(c => t.includes(c));
        const cloud = ["AWS", "Azure", "GCP", "Alibaba Cloud", "Tencent Cloud"].filter(c => t.includes(c));
        return { security: security.join(", ") || "未检测到", framework: framework.join(", ") || "未检测到", cloud: cloud.join(", ") || "未检测到" };
      } catch(e) { return { security: "Unknown", framework: "Unknown", cloud: "Unknown" }; }
    })(),
    // 5. Apollo 公司画像 (使用 /enrich 接口获取更全面的组织信息)
    env.APOLLO_API_KEY ? fetch(`https://api.apollo.io/api/v1/organizations/enrich?domain=${domain}`, {
      headers: { "Content-Type": "application/json", "X-Api-Key": env.APOLLO_API_KEY }
    }).then(r => r.json()).then(j => {
      const o = j.organization;
      if (!o) return { desc: "暂无画像", size: "?", funding: "?", fundingRound: "?", industry: "?", revenue: "?", keywords: "", city: "", country: "", founded: "?", linkedin: "" };
      return {
        desc: o.short_description || o.sanitized_description || "",
        size: o.estimated_num_employees || "?",
        funding: o.total_funding ? `$${(o.total_funding/1e6).toFixed(1)}M` : "未知",
        fundingRound: o.latest_funding_round_date ? `${o.latest_funding_stage || ''} (${o.latest_funding_round_date?.substring(0,7)})` : "未知",
        industry: o.industry || "未知",
        revenue: o.annual_revenue_printed || o.raw_address || "未知",
        keywords: (o.keywords || []).slice(0, 8).join(", "),
        city: o.city || "",
        country: o.country || "",
        founded: o.founded_year || "?",
        linkedin: o.linkedin_url || ""
      };
    }).catch(() => ({ desc: "暂无画像", size: "?", funding: "?", fundingRound: "?", industry: "?", revenue: "?", keywords: "", city: "", country: "", founded: "?", linkedin: "" })) : Promise.resolve({ desc: "N/A", size: "?", funding: "?", fundingRound: "?", industry: "?", revenue: "?", keywords: "", city: "", country: "", founded: "?", linkedin: "" }),
    // 6. Apollo 联系人打捞 — 两步法 (先搜索, 再用 Match API 解锁邮箱/电话)
    env.APOLLO_API_KEY ? (async () => {
      try {
        const cacheKey = `apollo_contacts_${domain}`;
        if (env.BDR_LEADS_CACHE) {
          const cached = await env.BDR_LEADS_CACHE.get(cacheKey, "json");
          if (cached) return cached;
        }

        const searchRes = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
          method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": env.APOLLO_API_KEY },
          body: JSON.stringify({
            q_organization_domains: domain,
            person_titles: ["CTO", "CIO", "CISO", "Director", "Security", "Infrastructure", "Engineering", "IT", "CEO", "Founder", "President"],
            person_seniorities: ["director", "vp", "c_suite", "owner", "founder"],
            per_page: 5   // 精准狙击: 全员解锁，最多消耗 5 credits
          })
        });
        if (!searchRes.ok) {
          const errText = await searchRes.text();
          return [{ name: `HTTP ${searchRes.status}`, title: errText.substring(0, 50), email: "-", phone: "-" }];
        }
        const searchData = await searchRes.json();
        const people = searchData.people || [];

        // Step 2: 策略 — 对所有人调用 Match 获取完整姓名，但只对前 3 名读取邮箱/电话（保护额度）
        const enriched = [];
        let emailMatchCount = 0;
        
        const matchedPeople = await Promise.all(people.map(async p => {
          try {
            const matchRes = await fetch("https://api.apollo.io/v1/people/match", {
              method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": env.APOLLO_API_KEY },
              body: JSON.stringify({ id: p.id })
            });
            if (matchRes.ok) {
              return (await matchRes.json()).person || null;
            }
          } catch(e) {}
          return null;
        }));

        for (let i = 0; i < people.length; i++) {
          const p = people[i];
          const m = matchedPeople[i];
          // 姓名：所有人都优先用 Match 返回的完整名字
          let fullName = (m ? (m.name || `${m.first_name||''} ${m.last_name||''}`.trim()) : '') 
                          || `${p.first_name||''} ${p.last_name || p.last_name_obfuscated || ''}`.trim() 
                          || p.name || "Unknown";
          // 邮箱/电话：既然 credits 已全部花出，全部显示
          let email = "-", phone = "-";
          if (m) {
            email = m.email || m.primary_email || p.email || (p.contact ? p.contact.email : null) || "-";
            const phones = m.phone_numbers || [];
            phone = phones[0]?.sanitized_number || m.phone_number || "-";
          } else {
            email = p.email || (p.contact ? p.contact.email : null) || "-";
          }
          enriched.push({ name: fullName, title: p.title || m?.title || "-", email, phone, actionLink: `https://app.apollo.io/#/people/${p.id}` });
        }
        
        if (env.BDR_LEADS_CACHE && enriched.length > 0) {
          await env.BDR_LEADS_CACHE.put(cacheKey, JSON.stringify(enriched), { expirationTtl: 2592000 }); // 缓存 30 天
        }
        return enriched;
      } catch(e) { return [{ name: "API Error", title: e.message || "Unknown error", email: "-", phone: "-" }]; }
    })() : Promise.resolve([]),
    // 7. 从 D1 拉取脉脉打捞的数据 (由本地脚本同步)
    env.DB ? env.DB.prepare('SELECT name, title, url FROM maimai_contacts WHERE company_name LIKE ? OR company_name LIKE ?')
      .bind(`%${displayName}%`, `%${domain.split('.')[0]}%`).all().then(r => r.results || []).catch(() => []) : Promise.resolve([]),
    // 8. 并发执行网页截图 (避免串行导致的超时)
    takeScreenshot(`https://${domain}`, env).catch(() => null)
  ]);

  // AI 攻坚策略 (AI - 三段式专家级输出，高可用 fallback)
  let aiStrategy = "AI 策略生成失败。";
  if (env.DEEPSEEK_API_KEY || env.AI) {
    try {
      const contactNames = contactData.map(c => c.name).join(', ');
      const englishDesc = apolloOrgData.desc && !['N/A','暂无画像',''].includes(apolloOrgData.desc) ? apolloOrgData.desc : '';
      const prompt = `你现在是 Cloudflare 的顶级业务开拓代表(BDR)。你需要基于以下情报，输出极具杀伤力的拓客策略。

【严格约束】
1. 事实绑定：仅限使用下面【情报区】提供的数据。如果某个项为“无”或“未检测到”，禁止在策略或邮件中提及该领域的竞品名称（严禁脑补 F5, Akamai, Imperva 等）。
2. 身份校验：如果【联系人名单】为空，冷邮件开头必须使用“IT 负责人”或“技术主管”等通用称呼，严禁虚构具体人名。
3. 语气：极其自然、地道的中文商务口吻，拒绝机器翻译感。

【情报区】
目标客户: ${displayName} (${domain})
【公司简介】${englishDesc || '无'}
【联系人名单】${contactNames || '暂无(使用通用称呼)'}
【公司画像】规模: ${apolloOrgData.size}人 | 行业: ${apolloOrgData.industry}
【现网探测】状态: ${httpData.status || 'Unknown'} | IP: ${dnsData.ips} | Server: ${httpData.server}
CF状态: ${httpData.cfProxy ? '已开启代理' : '未开启'} | Zero Trust: ${httpData.cfTeam ? '🔥 已部署' : '未探测到'}
【WAF雷达证据】F5: ${httpData.signatures?.f5 || '未检测到'} | Akamai: ${httpData.signatures?.akamai || '未检测到'} | Imperva: ${httpData.signatures?.imperva || '未检测到'}
【敏感暴露面】${crtData.sensitive.join(", ") || "无"}

请严格按以下格式输出：

### 📝 公司简介（中文）
(将【公司简介】翻译成简洁流畅的中文，不超过2句话。)

### 💡 核心切入点 (Core Hooks)
*   **[切入点1]**: (基于雷达证据，指出其安全或网络架构的一个具体优化点)
*   **[切入点2]**: (结合暴露面或技术栈差异提出 Cloudflare 的替代价值)

### 🎯 主推产品组合
1.  **[产品名称]** - [一句话理由]
2.  **[产品名称]** - [一句话理由]

### ✉️ 高转化冷邮件 (Cold Email)
（要求：语气自信。开篇直入主题；中间一句话点明 Cloudflare 核心价值；结尾 Call to Action。不超过 150 字，禁止使用[占位符]）

主题：关于贵司海外网络架构优化的探讨

[直接写邮件正文]`;
      const rawContent = await callAI(env, [{ role: "user", content: prompt }]);
      // 提取翻译好的中文简介，并从 AI 策略正文中剔除（避免重复显示）
      const descMatch = rawContent.match(/###\s*📝[^\n]*\n([\s\S]*?)(?=###)/);
      if (descMatch) {
        apolloOrgData.descCN = descMatch[1].trim();
        aiStrategy = rawContent.replace(/###\s*📝[^\n]*\n[\s\S]*?(?=###)/, '').trim();
      } else {
        aiStrategy = rawContent;
      }
    } catch(e) { console.error("AI Strategy generation failed:", e); }
  }
    const screenshotData = await takeScreenshot(`https://${domain}`, env).catch(() => null);
    if (screenshotData && env.REPORTS_BUCKET) {
      screenshot = await saveScreenshotToR2(domain, screenshotData, env);
    } else {
      screenshot = screenshotData; // fallback to raw buffer if no R2
    }

  return {
    domain, company: displayName,
    domainConfidence, domainSource, // 🔑 新增置信度字段
    ips: dnsData.ips, emailProvider: dnsData.emailProvider,
    serverHeader: httpData.server, cfProxy: httpData.cfProxy, cfTeam: httpData.cfTeam,
    signatures: httpData.signatures, securityMaturity: httpData.securityMaturity,
    sensitiveSubdomains: crtData.sensitive, totalSubdomains: crtData.total,
    aiStrategy, contacts: contactData, maimaiContacts: maimaiData, screenshot,
    orgIntel: apolloOrgData, techStack: bwData,
    maimaiCompanyUrl: `https://maimai.cn/web/search_center?type=contact&query=${encodeURIComponent(displayName + " CTO")}`
  };
}

// ── 自动发现引擎 (定时任务驱动) ──
function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch(e) {
    const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
    if (m) { try { return JSON.parse(m[1].trim()); } catch(e2) {} }
    const s = text.indexOf('{'), e2 = text.lastIndexOf('}');
    if (s !== -1 && e2 !== -1) { try { return JSON.parse(text.substring(s, e2+1)); } catch(e3) {} }
    return { company: null, score: 0, reason: '' };
  }
}

async function callAI(env, messages, options = {}) {
  if (env.DEEPSEEK_API_KEY) {
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: messages,
          ...options
        }),
        signal: AbortSignal.timeout(12000)
      });
      if (response.ok) {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
      } else {
        console.warn(`DeepSeek API failed with status ${response.status}`);
      }
    } catch (err) {
      console.warn("DeepSeek API call failed or timed out, falling back to Workers AI:", err);
    }
  }

  if (env.AI) {
    try {
      console.log("Using Cloudflare Workers AI Fallback (Qwen)...");
      const result = await env.AI.run("@cf/qwen/qwen1.5-14b-chat-awq", {
        messages: messages
      });
      if (result && result.response) {
        return result.response;
      }
    } catch (err) {
      console.error("Workers AI Qwen fallback failed, trying Llama 3:", err);
      try {
        const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
          messages: messages
        });
        if (result && result.response) {
          return result.response;
        }
      } catch (err2) {
        console.error("Workers AI Llama 3 fallback failed:", err2);
      }
    }
  }

  throw new Error("All AI endpoints failed");
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
  });
}

async function sendEmail(env, subject, htmlContent) {
  if (!env.SUBSCRIBER_EMAIL || !env.RESEND_API_KEY) return;
  try {
    const req = new Request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'BDR Intel Bot <onboarding@resend.dev>',
        to: [env.SUBSCRIBER_EMAIL],
        subject: subject,
        html: htmlContent
      })
    });
    const res = await fetch(req);
    if (!res.ok) {
      console.error('Resend Error:', await res.text());
    }
  } catch (err) {
    console.error('Failed to send email:', err);
  }
}

async function runDiscovery(env, ctx) {
  try {
    // 聚焦中国出海、融资、及华南地域关键词（重点：广东全域）
    const queries = [
      'site:36kr.com (出海 OR 获投 OR 广东 OR 深圳 OR 跨境 OR 东莞 OR 佛山 OR 珠海)', 
      'site:pedaily.cn (融资 OR 获投 OR 深圳 OR 广州 OR 东莞 OR 佛山)',
      'site:itjuzi.com (融资 OR 出海 OR 广东)',
      '(融资 OR 出海 OR 跨境) (深圳 OR 广州 OR 东莞 OR 佛山 OR 珠海 OR 汕头 OR 中山) when:1d'
    ];
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(queries.join(' OR ') + ' when:1d')}&hl=zh-CN`;
    const itJuziRssUrl = 'https://www.itjuzi.com/api/telegraph.xml';
    const customAlertsRssUrl = 'https://www.google.com/alerts/feeds/11937519344530559926/10956042884971852592';
    
    const [resGoogle, resITJuzi, resAlerts] = await Promise.all([
      fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null),
      fetch(itJuziRssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null),
      fetch(customAlertsRssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => null)
    ]);
    
    let combinedXml = '';
    if (resGoogle && resGoogle.ok) combinedXml += await resGoogle.text();
    if (resITJuzi && resITJuzi.ok) combinedXml += await resITJuzi.text();
    if (resAlerts && resAlerts.ok) combinedXml += await resAlerts.text();

    const items = [...combinedXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
      title: m[1].match(/<title>(.*?)<\/title>/)?.[1] || '',
      link:  m[1].match(/<link>(.*?)<\/link>/)?.[1]  || ''
    }));

    for (const item of items.slice(0, 15)) {
      let data = { company: null, score: 0, reason: '' };
      
      if (env.DEEPSEEK_API_KEY || env.AI) {
        try {
          const content = await callAI(env, [
            { 
              role: 'system', 
              content: `你是一个专业的 Cloudflare BDR 助手，专注于华南大区（广东/深圳/广州）的客户开发。
任务：分析新闻标题，识别是否有中国大陆公司（特别是华南地区公司）正在融资或准备出海。
规则：
1. 必须是中国大陆公司。忽略 Google, OpenAI, Anthropic 等纯外国公司。
2. 【重点关注】广东省各城市：深圳、广州、东莞、佛山、珠海、惠州、汕头、中山的公司。
3. 业务相关性：优先考虑游戏出海、跨境电商、SaaS、短剧/内容、金融科技等高度依赖 Cloudflare 的行业。
4. 返回 JSON: {"company":"全名", "location":"省份/城市", "isGuangdong":true/false, "isSouthChina":true/false, "score":1-10, "reason":"理由"}
5. 广东公司且有出海倾向的，score 必须 >= 9。广东公司无论是否出海，score 基础分 +2。` 
            }, 
            { role: 'user', content: item.title }
          ]);
          data = extractJSON(content);
        } catch(e) { console.error('AI discovery error in runDiscovery:', e); }
      }

        if (data.company && data.score >= 7 && env.DB) {
          const normalizedName = data.company.trim();
          
          const inLeads = await env.DB.prepare('SELECT id FROM leads WHERE company = ?').bind(normalizedName).first();
          const inProcessed = await env.DB.prepare('SELECT domain FROM processed_leads WHERE company_cn = ?').bind(normalizedName).first();
          
          if (!inLeads && !inProcessed) {
            const token = env.ACCESS_TOKEN || '';
            const probeUrl = `https://cfai.uk/?company=${encodeURIComponent(normalizedName)}&token=${encodeURIComponent(token)}`;
            
            let priorityLabel = data.score >= 9 ? '🔴 P0 紧急' : '🟠 P1 高价值';
            if (data.isGuangdong) priorityLabel = '🔥 广东核心线索';
            else if (data.isSouthChina) priorityLabel = '🟠 华南线索';

            // 华南标签
            const regionTag = data.isGuangdong ? '📍 广东 ★★★' : (data.isSouthChina ? '📍 华南 ★★' : `📍 ${data.location || '未知'}`);
            const msg = `${priorityLabel}\n\n🏢 公司: <b>${normalizedName}</b>\n${regionTag}\n⭐ 分数: ${data.score}/10\n💡 原因: ${data.reason}\n\n<a href="${probeUrl}">🚀 点击开始全自动深度侦察</a>`;
            
            await sendTelegram(env, msg);
            
            const emailSubject = `[BDR 线索] ${priorityLabel} - ${normalizedName}`;
            const emailHtml = `
              <div style="font-family: sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #F38020; border-bottom: 2px solid #eee; padding-bottom: 10px;">发现高价值线索: ${normalizedName}</h2>
                <p><b>评级:</b> ${priorityLabel} (${data.score}/10)</p>
                <p><b>标签:</b> ${regionTag}</p>
                <p><b>推荐理由:</b> ${data.reason}</p>
                <br><br>
                <a href="${probeUrl}" style="display:inline-block; background-color:#F38020; color:white; padding:12px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">🚀 点击开始全自动深度侦察</a>
              </div>
            `;
            await sendEmail(env, emailSubject, emailHtml);
            
            await env.DB.prepare('INSERT INTO leads (company, priority, score, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(data.company, data.score >= 9 ? 'P0' : 'P1', data.score, data.reason, 'pending', new Date().toISOString())
              .run();
          }
        }
    }
  } catch(e) { console.error('Discovery error:', e); }
}

export default {
  async email(message, env, ctx) {
    if (!env.DEEPSEEK_API_KEY && !env.AI) return;
    try {
      const parser = new PostalMime();
      const parsed = await parser.parse(message.raw);
      const content = parsed.text || parsed.html || "";
      
      const emailContent = await callAI(env, [
        { role: "system", content: "你是一个专业的 BDR 助手。请分析邮件内容，提取是否有公司正在融资、产品发布、或者是潜客相关的商机。请提取公司全称。返回 JSON 格式: {\"company\": \"...\", \"score\": 1-10, \"reason\": \"...\"}。若不相关，company 返回 null。" },
        { role: "user", content: `From: ${message.from}\nTo: ${message.to}\nSubject: ${message.headers.get("subject") || "No Subject"}\n\n${content.substring(0, 5000)}` }
      ]);
      
      const data = extractJSON(emailContent);
      
      if (data.company && data.score >= 7) {
        if (env.DB) {
          const normalizedName = data.company.trim();
          const exists = await env.DB.prepare("SELECT id FROM leads WHERE company = ?").bind(normalizedName).first();
          if (!exists) {
            await env.DB.prepare("INSERT INTO leads (company, priority, score, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
              .bind(normalizedName, data.score >= 9 ? "P0" : "P1", data.score, data.reason, new Date().toISOString()).run();
            
            const token = env.ACCESS_TOKEN || '';
            const probeUrl = `https://cfai.uk/?company=${encodeURIComponent(normalizedName)}&token=${encodeURIComponent(token)}`;
            
            let priorityLabel = data.score >= 9 ? '🔴 P0 紧急邮件情报' : '🟠 P1 邮件情报';
            const msg = `${priorityLabel}\n\n🏢 公司: <b>${normalizedName}</b>\n⭐ 分数: ${data.score}/10\n💡 发现来源: 订阅邮件拦截 (${message.from})\n🔍 原因: ${data.reason}\n\n<a href="${probeUrl}">🚀 点击开始全自动深度侦察</a>`;
            
            await sendTelegram(env, msg);
            
            const emailSubject = `[BDR 邮件拦截] ${priorityLabel} - ${normalizedName}`;
            const emailHtml = `
              <div style="font-family: sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #F38020; border-bottom: 2px solid #eee; padding-bottom: 10px;">拦截到邮件情报: ${normalizedName}</h2>
                <p><b>来源邮箱:</b> ${message.from}</p>
                <p><b>评级:</b> ${priorityLabel} (${data.score}/10)</p>
                <p><b>推荐理由:</b> ${data.reason}</p>
                <br><br>
                <a href="${probeUrl}" style="display:inline-block; background-color:#F38020; color:white; padding:12px 20px; text-decoration:none; border-radius:5px; font-weight:bold;">🚀 点击开始全自动深度侦察</a>
              </div>
            `;
            await sendEmail(env, emailSubject, emailHtml);
          }
        }
      }
    } catch(e) { console.error("Email processing error:", e); }
  },
  async scheduled(event, env, ctx) {
    // 根据 cron 表达式区分任务
    // 0 1 * * 1-5 是线索发现任务 (北京时间早上 9:00)
    if (event.cron === "0 1 * * 1-5") {
      ctx.waitUntil(runDiscovery(env, ctx));
    } else if (event.cron === "* * * * *") {
      // 每分钟任务：这里可以放队列处理逻辑，如果没有则留空，防止重复推送
      console.log("Minute cron triggered (heartbeat)");
    } else {
      // 默认执行 (如果是手动触发或自定义任务)
      ctx.waitUntil(runDiscovery(env, ctx));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const isAuthorized = !env.ACCESS_TOKEN || (token === env.ACCESS_TOKEN);

    if (url.pathname === "/test-email") {
      try {
        const req = new Request('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'BDR Intel Bot <onboarding@resend.dev>',
            to: [env.SUBSCRIBER_EMAIL || 'chenjhj@gmail.com'],
            subject: 'Test from Cloudflare Worker (Resend)',
            html: '<p>This is a test email from the Cloudflare worker using Resend API.</p>'
          })
        });
        const res = await fetch(req);
        const text = await res.text();
        return new Response(`Status: ${res.status}\nBody: ${text}`, { status: 200 });
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    // ── 本地同步接口 ──
    if (url.pathname === "/record" && request.method === "POST") {
      if (!isAuthorized) return new Response("Unauthorized", { status: 401 });
      try {
        const data = await request.json();
        await env.DB.prepare("INSERT OR REPLACE INTO processed_leads (domain, company_cn, ae, contacts_found, cf_team, processed_date) VALUES (?,?,?,?,?,?)")
          .bind(data.domain, data.company_cn, data.ae, data.contacts_found, data.cf_team ? 1:0, new Date().toISOString()).run();
        return new Response("Synced", { status: 200 });
      } catch(e) { return new Response(e.message, { status: 500 }); }
    }

    // ── Telegram Webhook 交互接口 ──
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          let company = update.message.text.trim();
          
          if (company === "/testapollo") {
            try {
              const searchRes = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
                method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": env.APOLLO_API_KEY },
                body: JSON.stringify({
                  q_organization_domains: "cmcm.com",
                  person_titles: ["CTO", "CIO", "CISO", "Director", "Security", "Infrastructure", "Engineering", "IT", "CEO", "Founder", "President"],
                  person_seniorities: ["director", "vp", "c_suite", "owner", "founder"],
                  per_page: 5
                })
              });
              const text = await searchRes.text();
              await sendTelegram(env, `TEST APOLLO:\nStatus: ${searchRes.status}\nRaw Text:\n${text.substring(0, 500)}`);
            } catch(e) {
              await sendTelegram(env, `TEST APOLLO ERROR: ${e.message}`);
            }
            return new Response("OK");
          }

          if (company === "/start" || company === "/help") {
            await sendTelegram(env, 
              "🚀 <b>BDR Intel Bot 使用说明</b>\n\n" +
              "📌 <b>基础用法</b>：直接发送公司名即可开始探测\n" +
              "   例如：<code>晶泰科技</code>\n" +
              "   例如：<code>大疆</code>\n\n" +
              "📌 <b>指定域名</b>：用 /bdr 命令指定确切域名\n" +
              "   例如：<code>/bdr xtalpi.com</code>\n\n" +
              "📌 <b>其他命令</b>：\n" +
              "   /start 或 /help — 显示此帮助\n" +
              "   /testapollo — 测试 Apollo API 连通性\n\n" +
              "⚠️ 注意：只发公司名，不要带 /job /search 等前缀，否则会被忽略。"
            );
            return new Response("OK");
          }

          // /bdr 命令：允许直接指定域名，如 /bdr xtalpi.com
          if (company.startsWith("/bdr ")) {
            company = company.slice(5).trim(); // 去掉 "/bdr "
          } else if (company.startsWith("/")) {
            // ⚠️ 严格拦截：所有其他未识别的斜杠命令，直接返回提示，绝不进入 OSINT
            const unknownCmd = company.split(" ")[0];
            await sendTelegram(env,
              `⚠️ 未识别的命令: <code>${unknownCmd}</code>\n\n` +
              `如需探测公司，请<b>直接发送公司名</b>（不要带斜杠前缀），例如：\n<code>晶泰科技</code>\n\n发送 /help 查看完整使用说明。`
            );
            return new Response("OK");
          }

          // 空输入保护
          if (!company || company.length < 2) {
            await sendTelegram(env, "⚠️ 请输入有效的公司名称（至少2个字符）。");
            return new Response("OK");
          }

          // 发送受理通知
          await sendTelegram(env, `🔍 正在对 <b>${company}</b> 进行深度探测，请稍候...`);

          // 异步运行探测并推送结果
          ctx.waitUntil((async () => {
            try {
              const data = await runOSINT(company, null, env);
              const token = env.ACCESS_TOKEN || '';
              const reportUrl = `https://cfai.uk/?company=${encodeURIComponent(company)}&token=${encodeURIComponent(token)}`;
              
              // 🔑 域名置信度标签
              const confLabel = data.domainConfidence === 'high' ? '🟢 高置信度' :
                               data.domainConfidence === 'medium' ? '🟡 中置信度' : '🔴 低置信度(AI推测，请核查)';
              const summary = `✅ <b>探测完成: ${data.company}</b>\n\n` +
                `🌐 域名: <code>${data.domain}</code> ${confLabel}\n` +
                `📍 域名来源: ${data.domainSource || '未知'}\n` +
                `🛡️ 代理: ${data.cfProxy ? '已开启' : '未开启'}\n` +
                `👥 联系人: 已找到 ${data.contacts.length} 位\n\n` +
                `<a href="${reportUrl}">查看完整 Intelligence Report 🚀</a>`;
              
              await sendTelegram(env, summary);

              // 异步触发本地深度扫描（不阻塞 Telegram 回复）
              await callBridge(data.company, data.domain, env);
            } catch (err) {
              await sendTelegram(env, `❌ 探测 <b>${company}</b> 失败: ${err.message}`);
            }
          })());
        }
        return new Response("OK");
      } catch (e) { return new Response("OK"); }
    }

    // ── 查重接口 ──
    if (url.pathname === "/check") {
      const d = url.searchParams.get("domain");
      if (!d) return new Response("Missing domain", { status: 400 });
      const res = await env.DB.prepare("SELECT * FROM processed_leads WHERE domain = ?").bind(d).first();
      return new Response(JSON.stringify({ exists: !!res, data: res }), { headers: { "Content-Type": "application/json" } });
    }

    // ── 实战账本 ──
    if (url.pathname === "/leads") {
      if (!isAuthorized) return new Response("Unauthorized", { status: 401 });
      const { results } = await env.DB.prepare("SELECT * FROM processed_leads ORDER BY processed_date DESC LIMIT 50").all();
      const rows = results.map(r => `<tr><td>${r.processed_date?.split('T')[0]}</td><td><b>${r.company_cn}</b><br><small>${r.domain}</small></td><td>${r.ae}</td><td>${r.contacts_found}</td><td>${r.cf_team ? '🔥' : '❌'}</td></tr>`).join('');
      return new Response(`<html><head><meta charset="utf-8"><style>body{background:#0d0d0d;color:#eee;font-family:sans-serif;padding:20px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #333}th{color:#F38020;text-align:left}</style></head><body><h1>📊 实战账本</h1><table><tr><th>日期</th><th>客户</th><th>AE</th><th>联系人</th><th>CF</th></tr>${rows}</table></body></html>`, { headers: {"Content-Type": "text/html; charset=utf-8"} });
    }

    // ── 主页：搜索表单 + OSINT 报告 ──
    if (url.pathname === "/") {
      const company = url.searchParams.get("company");
      const domainInput = url.searchParams.get("domain");
      const hasInput = company || domainInput;
      if (!hasInput) {
        return new Response(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>BDR Intel Radar</title>
          <style>:root{--cf:#F38020;--bg:#0D0D0D;--p:#1A1A1A}body{background:var(--bg);color:#eee;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
          .box{background:var(--p);padding:40px;border-radius:8px;border:1px solid #333;width:340px;box-shadow:0 10px 25px rgba(0,0,0,0.5)}
          h1 span{color:var(--cf)}input{width:100%;padding:12px;margin-bottom:15px;background:#000;border:1px solid #444;color:#fff;border-radius:4px;box-sizing:border-box}
          button{width:100%;padding:12px;background:var(--cf);border:none;color:#fff;font-weight:bold;cursor:pointer;border-radius:4px;font-size:15px}
          .hint{font-size:12px;color:#555;margin-bottom:8px}</style></head>
          <body><div class="box"><h1><span>BDR</span> Intel Radar</h1>
          <form method="GET" onsubmit="return checkForm()">
            <p class="hint">公司名和域名填写一个即可；如两者都填，以域名为准。</p>
            <input name="company" id="company" placeholder="公司名 (可选，如: 晶泰科技)">
            <input name="domain" id="domain" placeholder="官网域名 (可选，如: xtalpi.com)">
            <input name="token" id="token" type="password" placeholder="Passcode (必填)" required>
            <button>Deploy Probe 🚀</button>
          </form></div>
          <script>
            function checkForm() {
              if (!document.getElementById('company').value && !document.getElementById('domain').value) {
                alert('公司名或域名至少填写一项！'); return false;
              }
              return true;
            }
          </script>
          </body></html>`, { headers: {"Content-Type": "text/html; charset=utf-8"} });
      }

      if (!isAuthorized) return new Response(`<!DOCTYPE html><html><body style="background:#0d0d0d;color:#F38020;font-family:sans-serif;padding:30px"><h1>🚨 授权失败：Passcode 错误。</h1><a href="/" style="color:#F38020">← 返回</a></body></html>`, { status: 401, headers: {"Content-Type": "text/html; charset=utf-8"} });
      
      // ── R2 截图服务 ──
      if (url.pathname === "/screenshot") {
        const domain = url.searchParams.get("domain");
        if (!domain || !env.REPORTS_BUCKET) return new Response("Not Found", { status: 404 });
        const key = `screenshots/${domain}.jpg`;
        const object = await env.REPORTS_BUCKET.get(key);
        if (!object) return new Response("Not Found", { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        return new Response(object.body, { headers });
      }

      try {
        const data = await runOSINT(company, domainInput, env);
        // 自动写入账本
        if (env.DB) {
          await env.DB.prepare("INSERT OR REPLACE INTO processed_leads (domain, company_cn, ae, contacts_found, cf_team, processed_date) VALUES (?,?,?,?,?,?)")
            .bind(data.domain, data.company, "WebUI", data.contacts.length, data.cfProxy?1:0, new Date().toISOString()).run();
        }

        // 异步触发本地深度扫描（不阻塞页面输出）
        ctx.waitUntil(callBridge(data.company, data.domain, env));

        return new Response(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>${data.company} - BDR Intel</title>
          <style>:root{--cf:#F38020;--bg:#0D0D0D;--p:#1A1A1A}body{background:var(--bg);color:#eee;font-family:sans-serif;padding:30px}
          .card{background:var(--p);padding:20px;border-radius:8px;border:1px solid #333;margin-bottom:20px}
          h2{color:var(--cf);border-bottom:1px solid #333;padding-bottom:10px;margin-top:0}
          .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
          pre{white-space:pre-wrap;background:rgba(0,0,0,0.3);padding:15px;border-radius:4px;color:#cbd5e1;line-height:1.6;margin:0}
          table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #333;text-align:left}th{color:#888;font-size:12px;text-transform:uppercase}
          code{color:var(--cf)}a{color:var(--cf)}.badge-yes{color:#22c55e}.badge-no{color:#ef4444}</style></head>
          <body>
          <h1>BDR Intelligence: ${data.company}</h1>
          <p>目标域名: <code>${data.domain}</code> &nbsp;|&nbsp; <a href="/">← 返回搜索</a></p>
          <div class="grid">
            <div class="card"><h2>🏢 公司画像</h2>
              <p>${data.orgIntel.descCN || data.orgIntel.desc || '暂无描述'}</p>
              <table>
                <tr><td>📊 规模</td><td>${data.orgIntel.size}人</td><td>💰 融资总额</td><td>${data.orgIntel.funding}</td></tr>
                <tr><td>📅 最新轮次</td><td>${data.orgIntel.fundingRound}</td><td>🏭 行业</td><td>${data.orgIntel.industry}</td></tr>
                <tr><td>🌍 地区</td><td>${data.orgIntel.city} ${data.orgIntel.country}</td><td>📆 成立年份</td><td>${data.orgIntel.founded}</td></tr>
              </table>
              ${data.orgIntel.linkedin ? `<p style="margin-top:8px;margin-bottom:4px"><a href="${data.orgIntel.linkedin}" target="_blank">🔗 LinkedIn 页面</a></p>` : ''}
              <p style="margin-top:4px"><a href="${data.maimaiCompanyUrl}" target="_blank" style="color:#00c2ff">💙 脉脉公司主页</a></p>
              <p style="margin-top:8px"><b>关键词:</b> <small>${data.orgIntel.keywords || 'N/A'}</small></p>
            </div>
            <div class="card"><h2>🌐 基础设施 & 安全水位</h2>
              <p>IP: <code>${data.ips}</code></p>
              <p>邮件服务: <b>${data.emailProvider}</b></p>
              <p>Server: ${data.serverHeader}
                ${data.cfProxy ? '<span class="badge-yes">✅ CF Protected</span>' : '<span class="badge-no">❌ Origin Exposed</span>'}</p>
              
              <p><b>🛡️ WAF 竞品雷达:</b><br>
                ${data.signatures.akamai ? '<span class="badge-yes">🔥 检测到 Akamai (抢单机会)</span>' : ''}
                ${data.signatures.imperva ? '<span class="badge-yes">🔥 检测到 Imperva (抢单机会)</span>' : ''}
                ${data.signatures.awsWaf ? '<span class="badge-yes">⚠️ AWS WAF (云协同机会)</span>' : ''}
                ${data.signatures.fastly ? '<span class="badge-yes">⚠️ Fastly (替代机会)</span>' : ''}
                ${(!data.signatures.akamai && !data.signatures.imperva && !data.signatures.awsWaf && !data.signatures.fastly) ? '<span style="color:#666">未检测到主流竞品 WAF</span>' : ''}
              </p>

              <p><b>🔐 安全合规水位 (Security Headers):</b><br>
                HSTS: ${data.securityMaturity.hsts ? '✅' : '❌'} | 
                CSP: ${data.securityMaturity.csp ? '✅' : '❌'} | 
                X-Frame: ${data.securityMaturity.xFrame ? '✅' : '❌'}
              </p>

              <p>Zero Trust: ${data.cfTeam ? '<span class="badge-yes">🔥 Active</span>' : '<span class="badge-no">❌ None</span>'}</p>
              <p><b>技术栈 (BuiltWith):</b><br>
                ☁️ 云厂商: ${data.techStack.cloud}<br>
                🖥️ 框架: ${data.techStack.framework}
              </p>
              <p style="color:#ef4444"><b>暴露资产 (${data.totalSubdomains} 个):</b> ${data.sensitiveSubdomains.join(", ") || "None"}</p>
            </div>
          </div>
          <div class="card"><h2>🧠 AI 攻坚策略 (DeepSeek)</h2><pre>${data.aiStrategy}</pre></div>
          <div class="card"><h2>👥 关键决策人 (Apollo)</h2>
            <table><tr><th>姓名</th><th>职位</th><th>邮箱</th><th>电话</th><th>操作</th></tr>
            ${data.contacts.map(c => `<tr><td><b>${c.name}</b></td><td>${c.title}</td><td><code>${c.email}</code></td><td><code>${c.phone}</code></td><td><a href="${c.actionLink}" target="_blank">Apollo →</a></td></tr>`).join('')}
            </table>
          </div>
          ${data.maimaiContacts.length > 0 ? `
          <div class="card" style="border-left: 4px solid #00c2ff;"><h2>💙 脉脉深度人脉 (CN Professional)</h2>
            <table><tr><th>姓名</th><th>职位</th><th>详情</th></tr>
            ${data.maimaiContacts.map(m => `<tr><td><b>${m.name}</b></td><td>${m.title}</td><td><a href="${m.url}" target="_blank" style="color:#00c2ff">查看脉脉主页 →</a></td></tr>`).join('')}
            </table>
          </div>` : ''}
          ${data.screenshot ? `
            <div class="card"><h2>📸 官网实拍</h2>
              ${(typeof data.screenshot === 'string') ? 
                `<img src="${data.screenshot}" style="width:100%;border-radius:4px;">` : 
                `<img src="data:image/jpeg;base64,${Buffer.from(data.screenshot).toString('base64')}" style="width:100%;border-radius:4px;">`
              }
            </div>` : ''}

          </body></html>`, { headers: {"Content-Type": "text/html; charset=utf-8"} });
      } catch (err) {
        return new Response(`<html><body style="background:#0d0d0d;color:#ef4444;font-family:sans-serif;padding:30px"><h1>🚨 探测失败</h1><p>${err.message}</p><a href="/" style="color:#F38020">← 返回</a></body></html>`, { status: 400, headers: {"Content-Type": "text/html; charset=utf-8"} });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};
