/** Generic RSS/Atom -> Gemini -> Telegram pipeline for Google Apps Script. */

// Deployment-specific values are read from Script Properties. Keep this object
// as the single place for all AI instructions.
const PROMPTS = {
  outputLanguage: 'Persian',
  base: [
    'Create concise, accurate posts from the supplied source data.',
    'Do not add facts absent from the input; preserve names and technical identifiers.',
    'Do not generate destination names, private identifiers or promotional hashtags.',
    'Avoid clickbait, speculation and exaggerated claims.'
  ],
  fields: [
    'title: a short, precise title in the requested language.',
    'summary: 2 to 4 clear sentences in the requested language.',
    'tags: 3 to 6 relevant hashtags in one space-separated string.'
  ],
  categories: {
    security: 'Cybersecurity, vulnerabilities, malware, incidents and security tools.',
    development: 'Software engineering, DevOps, cloud, open source, languages and frameworks.',
    technology: 'Technology, software, hardware, AI, internet and technology companies.',
    general: 'General news and information technology.'
  },
  sourceTypes: { github: 'These are software repositories. Explain each project using only supplied metadata.' }
};

const LIMITS = {
  maxPostsPerRun: 3, maxPostsPerSource: 3, maxFeedItemsToScan: 30,
  maxGitHubItemsToScan: 15, maxDescriptionCharsForAI: 1800,
  maxSentHashesPerSource: 180, maxRecentTitles: 60,
  duplicateSimilarityThreshold: 0.82, maxArticleAgeHours: 48
};

// Safe examples only. Set SOURCES_JSON to replace this array completely.
const DEFAULT_SOURCES = [
  { id: 'security-feed', type: 'rss', name: 'Security feed', feedUrl: 'https://feeds.feedburner.com/TheHackersNews', category: 'security', headlinePrefix: 'Security news', fixedTags: '#security', maxPostsPerRun: 3 },
  { id: 'technology-feed', type: 'rss', name: 'Technology feed', feedUrl: 'https://feeds.arstechnica.com/arstechnica/index', category: 'technology', headlinePrefix: 'Technology news', fixedTags: '#technology', maxPostsPerRun: 3 }
];

function getSources() {
  const raw = PropertiesService.getScriptProperties().getProperty('SOURCES_JSON');
  if (!raw) return DEFAULT_SOURCES;
  let value; try { value = JSON.parse(raw); } catch (e) { throw new Error('SOURCES_JSON is not valid JSON.'); }
  if (!Array.isArray(value) || !value.length) throw new Error('SOURCES_JSON must be a non-empty array.');
  return value.map(normalizeSource);
}
function normalizeSource(source, index) {
  const item = source || {}, type = String(item.type || 'rss').toLowerCase();
  const id = String(item.id || 'source_' + index).trim(), name = String(item.name || id).trim();
  if (!id || !name) throw new Error('Each source needs id and name.');
  if (type === 'rss' && !String(item.feedUrl || '').trim()) throw new Error(id + ' needs feedUrl.');
  if (type === 'github' && !String(item.trendingUrl || '').trim()) throw new Error(id + ' needs trendingUrl.');
  return { id: id, type: type, name: name, feedUrl: String(item.feedUrl || '').trim(), trendingUrl: String(item.trendingUrl || '').trim(), category: String(item.category || 'general').toLowerCase().trim(), headlinePrefix: String(item.headlinePrefix || name).trim(), fixedTags: String(item.fixedTags || '').trim(), maxPostsPerRun: Math.max(1, Number(item.maxPostsPerRun || LIMITS.maxPostsPerSource)) };
}
function prop(name, fallback) { return PropertiesService.getScriptProperties().getProperty(name) || fallback; }
function boolProp(name, fallback) { const value = PropertiesService.getScriptProperties().getProperty(name); return value === null || value === '' ? fallback : /^(true|1|yes)$/i.test(value); }

function scheduler() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(3000)) return;
  try {
    const properties = PropertiesService.getScriptProperties(), token = properties.getProperty('TELEGRAM_BOT_TOKEN'), key = properties.getProperty('GEMINI_API_KEY'), fallback = boolProp('ENABLE_AI_FALLBACK', true);
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing from Script Properties.');
    if (!key && !fallback) throw new Error('GEMINI_API_KEY is missing and fallback is disabled.');
    const source = getSourceForCurrentHour(getSources()); if (!source) return;
    const seen = loadJson('SEEN_' + source.id), recent = loadRecentTitles();
    const candidates = source.type === 'github' ? getGitHubCandidates(source, seen) : getRssCandidates(source, seen);
    const selected = []; const max = Math.min(LIMITS.maxPostsPerRun, source.maxPostsPerRun);
    for (let i = 0; i < candidates.length && selected.length < max; i++) {
      const item = candidates[i], title = normalizeTitle(item.title), duplicate = findSimilarRecentTitle(title, recent);
      if (duplicate && !hasAnyTelegramReceipt(source.id, item.link)) { rememberSeen(source, seen, item.link); continue; }
      selected.push(item);
    }
    if (!selected.length) return;
    let results = null;
    if (key) { try { results = summarizeBatchWithGemini(source, selected, key); } catch (e) { if (!fallback) throw e; console.warn('AI unavailable; using fallback.'); } }
    results = results || selected.map(buildFallbackResult); let sent = 0, updatedTitles = recent.slice();
    selected.forEach(function(item, index) {
      if (index) Utilities.sleep(1100);
      try { sendCandidate(source, item, results[index] || buildFallbackResult(item), token); rememberSeen(source, seen, item.link); const title = normalizeTitle(item.title); if (title) updatedTitles = keepLast(updatedTitles.concat([title]), LIMITS.maxRecentTitles); sent++; } catch (e) { console.error('Publish failed: ' + redact(e, token)); }
    });
    if (sent) saveJson('RECENT_TITLES', updatedTitles);
  } finally { lock.releaseLock(); }
}
function getSourceForCurrentHour(sources) { return sources && sources.length ? sources[Math.floor(Date.now() / 3600000) % sources.length] : null; }

function fetchText(url, headers) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: headers || { 'User-Agent': 'ContentAutomationBot/1.0' } });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Source HTTP ' + response.getResponseCode());
  return response.getContentText();
}
function getRssCandidates(source, seen) {
  const now = Date.now(), items = parseFeed(fetchText(source.feedUrl));
  return items.slice(0, LIMITS.maxFeedItemsToScan).filter(function(item) { return item.link && seen.indexOf(hash(item.link)) < 0 && (!item.publishedAt || LIMITS.maxArticleAgeHours <= 0 || now - item.publishedAt <= LIMITS.maxArticleAgeHours * 3600000); }).sort(function(a, b) { return (a.publishedAt || 0) - (b.publishedAt || 0); });
}
function parseFeed(xml) {
  const root = XmlService.parse(xml).getRootElement(), atom = root.getName().toLowerCase() === 'feed';
  const channel = root.getChild('channel'), entries = atom ? root.getChildren('entry') : (channel ? channel.getChildren('item') : root.getChildren('item'));
  return entries.map(function(entry) { const title = childText(entry, 'title'), description = childText(entry, atom ? 'summary' : 'description') || childText(entry, 'content'), link = atom ? atomLink(entry) : childText(entry, 'link') || childText(entry, 'guid'), date = childText(entry, atom ? 'updated' : 'pubDate') || childText(entry, 'published'); return { title: stripHtml(title), description: description, link: String(link || '').trim(), publishedAt: dateValue(date) }; }).filter(function(item) { return item.link; });
}
function childText(element, name) { const child = element.getChildren().find(function(item) { return item.getName().toLowerCase() === name.toLowerCase(); }); return child ? child.getText() : ''; }
function atomLink(entry) { const links = entry.getChildren('link'); for (let i = 0; i < links.length; i++) { const rel = links[i].getAttribute('rel'), href = links[i].getAttribute('href'); if (href && (!rel || rel.getValue() === 'alternate')) return href.getValue(); } return ''; }
function dateValue(value) { const timestamp = value ? new Date(value).getTime() : 0; return isNaN(timestamp) ? 0 : timestamp; }
function getGitHubCandidates(source, seen) {
  const html = fetchText(source.trendingUrl, { 'User-Agent': 'ContentAutomationBot/1.0', 'Accept-Language': 'en-US,en;q=0.9' }), articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || [], result = [];
  for (let i = 0; i < articles.length && result.length < LIMITS.maxGitHubItemsToScan; i++) { const match = articles[i].match(/<h2\b[\s\S]*?<a\b[^>]*href=["']\/([^"'?#]+\/[^"'?#]+)["']/i); if (!match) continue; const repo = decodeHtml(match[1]).replace(/\s+/g, ''), link = 'https://github.com/' + repo; if (seen.indexOf(hash(link)) < 0) result.push({ title: repo, link: link, description: extractDescription(articles[i]), publishedAt: Date.now() }); }
  return result;
}
function extractDescription(html) { const paragraphs = html.match(/<p\b[\s\S]*?<\/p>/gi) || []; for (let i = 0; i < paragraphs.length; i++) { const value = stripHtml(paragraphs[i]).replace(/\s+/g, ' ').trim(); if (value.length >= 20 && !/sponsor/i.test(value)) return value; } return ''; }

function summarizeBatchWithGemini(source, items, apiKey) {
  const input = items.map(function(item, index) { return { id: 'item_' + index, title: String(item.title || '').trim(), description: stripHtml(item.description || '').substring(0, LIMITS.maxDescriptionCharsForAI) }; });
  const language = prop('OUTPUT_LANGUAGE', PROMPTS.outputLanguage), category = PROMPTS.categories[source.category] || PROMPTS.categories.general, sourceType = PROMPTS.sourceTypes[source.type] || '';
  const prompt = ['Write posts in ' + language + ' for the configured publishing destination.', 'Source: ' + source.name, 'Topic guidance: ' + category, sourceType, 'Rules:\n- ' + PROMPTS.base.concat(PROMPTS.fields).join('\n- '), 'Return only JSON: {"items":[{"id":"item_0","title":"...","summary":"...","tags":"..."}]}', 'Input:\n' + JSON.stringify(input)].filter(Boolean).join('\n\n');
  const model = prop('AI_MODEL', 'gemini-2.0-flash-lite'), response = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-goog-api-key': apiKey }, payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1800, responseMimeType: 'application/json' } }) });
  const code = response.getResponseCode(), body = response.getContentText(); if (code < 200 || code >= 300) throw new Error('AI HTTP ' + code);
  let data; try { data = JSON.parse(body); } catch (e) { throw new Error('AI returned invalid JSON.'); }
  const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts ? data.candidates[0].content.parts.map(function(part) { return part.text || ''; }).join('') : ''; if (!text) throw new Error('AI response has no content.');
  let parsed; try { parsed = JSON.parse(text); } catch (e) { throw new Error('AI output is not valid JSON.'); }
  const byId = {}; (parsed.items || []).forEach(function(item) { if (item && item.id) byId[item.id] = item; });
  return items.map(function(item, index) { const value = byId['item_' + index] || {}; return { title: String(value.title || item.title).trim(), summary: String(value.summary || stripHtml(item.description || '')).trim(), tags: String(value.tags || '').trim() }; });
}
function buildFallbackResult(item) { return { title: String(item.title || '').trim(), summary: stripHtml(item.description || '').substring(0, 650), tags: '' }; }

function sendCandidate(source, item, result, token) {
  const title = sanitize(result.title || item.title).substring(0, 180), summary = sanitize(result.summary || item.description).substring(0, 650), tags = sanitize(result.tags || '').replace(/[ \t]{2,}/g, ' ').trim().substring(0, 140);
  const message = '<b>' + escapeHtml(source.headlinePrefix) + ' — ' + escapeHtml(title) + '</b>\n\n' + escapeHtml(summary) + '\n\n<b>Source:</b> ' + escapeHtml(source.name) + '\n<a href="' + escapeHtml(item.link) + '">Read original</a>\n\n' + escapeHtml(sanitize(source.fixedTags)) + (tags ? ' ' + escapeHtml(tags) : '');
  sendToTelegram(message, token, '', { sourceId: source.id, link: item.link });
}
function sendToTelegram(message, token, imageUrl, context) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing.'); const channels = getTelegramChannels(), linkHash = context ? hash(context.link) : '';
  const jobs = channels.map(function(channel) { const key = context ? receiptKey(context.sourceId, channel) : ''; return { channel: channel, key: key, receipts: key ? loadJson(key) : [] }; }).filter(function(job) { return !linkHash || job.receipts.indexOf(linkHash) < 0; }); if (!jobs.length) return;
  const photo = Boolean(imageUrl) && message.length <= 1000, method = photo ? 'sendPhoto' : 'sendMessage';
  const requests = jobs.map(function(job) { const payload = { chat_id: job.channel, parse_mode: 'HTML' }; if (photo) { payload.photo = imageUrl; payload.caption = message; } else { payload.text = message; payload.link_preview_options = { is_disabled: false }; } return { url: 'https://api.telegram.org/bot' + token + '/' + method, method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true }; });
  const responses = UrlFetchApp.fetchAll(requests), errors = []; responses.forEach(function(response, index) { const result = telegramResult(response); if (!result.ok) errors.push(jobs[index].channel + ': ' + result.description); else if (jobs[index].key) saveJson(jobs[index].key, keepLast(jobs[index].receipts.concat([linkHash]), LIMITS.maxSentHashesPerSource)); }); if (errors.length) throw new Error('Telegram delivery incomplete: ' + errors.join('; '));
}
function getTelegramChannels() { const props = PropertiesService.getScriptProperties(); let value = props.getProperty('TELEGRAM_CHANNELS') || ''; const json = props.getProperty('TELEGRAM_CHANNELS_JSON'); if (json) { try { value = JSON.parse(json); } catch (e) { throw new Error('TELEGRAM_CHANNELS_JSON is invalid.'); } } const channels = (Array.isArray(value) ? value : String(value).split(',')).map(function(item) { return String(item || '').trim(); }).filter(Boolean); if (!channels.length) throw new Error('Set TELEGRAM_CHANNELS or TELEGRAM_CHANNELS_JSON.'); return Array.from(new Set(channels)); }
function telegramResult(response) { let data = null; try { data = JSON.parse(response.getContentText()); } catch (e) {} return { ok: response.getResponseCode() >= 200 && response.getResponseCode() < 300 && Boolean(data && data.ok), description: data && data.description || 'HTTP ' + response.getResponseCode() }; }

function hash(value) { const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value)); return bytes.map(function(byte) { const number = byte < 0 ? byte + 256 : byte; return ('0' + number.toString(16)).slice(-2); }).join(''); }
function loadJson(key) { const raw = PropertiesService.getScriptProperties().getProperty(key); if (!raw) return []; try { const value = JSON.parse(raw); return Array.isArray(value) ? value : []; } catch (e) { return []; } }
function saveJson(key, value) { PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value)); }
function rememberSeen(source, seen, link) { const value = hash(link); if (seen.indexOf(value) < 0) seen.push(value); saveJson('SEEN_' + source.id, keepLast(seen, LIMITS.maxSentHashesPerSource)); }
function receiptKey(sourceId, channel) { return 'TELEGRAM_SENT_' + sourceId + '_' + hash(channel); }
function hasAnyTelegramReceipt(sourceId, link) { const value = hash(link); return getTelegramChannels().some(function(channel) { return loadJson(receiptKey(sourceId, channel)).indexOf(value) >= 0; }); }
function loadRecentTitles() { return loadJson('RECENT_TITLES').filter(function(item) { return typeof item === 'string'; }); }
function keepLast(value, max) { return (value || []).slice(-max); }
function normalizeTitle(value) { return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function findSimilarRecentTitle(title, recent) { if (!title) return null; for (let i = recent.length - 1; i >= 0; i--) { const similarity = titleSimilarity(title, recent[i]); if (similarity >= LIMITS.duplicateSimilarityThreshold) return { similarity: similarity }; } return null; }
function titleSimilarity(a, b) { const left = new Set(a.split(/\s+/).filter(Boolean)), right = new Set(String(b || '').split(/\s+/).filter(Boolean)); let common = 0; left.forEach(function(item) { if (right.has(item)) common++; }); return left.size + right.size - common ? common / (left.size + right.size - common) : 0; }
function sanitize(value) { const blocked = prop('BLOCKED_HASHTAGS', '').split(/[\s,]+/).filter(Boolean).map(escapeRegExp); return blocked.length ? String(value || '').replace(new RegExp(blocked.join('|'), 'giu'), '').trim() : String(value || '').trim(); }
function stripHtml(value) { return decodeHtml(String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function decodeHtml(value) { return String(value || '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&#x([0-9a-f]+);/gi, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); }).replace(/&#(\d+);/g, function(_, number) { return String.fromCharCode(Number(number)); }); }
function escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function redact(error, token) { return String(error && error.message || error).split(String(token || '')).join('[REDACTED]'); }

function setupTrigger() { ScriptApp.getProjectTriggers().forEach(function(trigger) { if (trigger.getHandlerFunction() === 'scheduler') ScriptApp.deleteTrigger(trigger); }); ScriptApp.newTrigger('scheduler').timeBased().everyHours(1).create(); }
function testScheduler() { scheduler(); }
function testSource(sourceId) { const source = getSources().find(function(item) { return item.id === sourceId; }); if (!source) throw new Error('Source not found: ' + sourceId); const seen = loadJson('SEEN_' + source.id), items = source.type === 'github' ? getGitHubCandidates(source, seen) : getRssCandidates(source, seen); console.log(JSON.stringify(items.slice(0, 10), null, 2)); }
function testTelegramChannels() { sendToTelegram('<b>Test message</b>\nTelegram configuration is working.', PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN'), '', null); }
function debugBotState() { const value = PropertiesService.getScriptProperties().getProperties(); Object.keys(value).forEach(function(key) { if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) value[key] = '[REDACTED]'; }); console.log(JSON.stringify(value, null, 2)); }
function resetNewsHistory() { const properties = PropertiesService.getScriptProperties(); getSources().forEach(function(source) { properties.deleteProperty('SEEN_' + source.id); }); properties.deleteProperty('RECENT_TITLES'); Object.keys(properties.getProperties()).forEach(function(key) { if (key.indexOf('TELEGRAM_SENT_') === 0) properties.deleteProperty(key); }); }
