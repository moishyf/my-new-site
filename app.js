/* =========================
   State
========================= */
let mediaRecorder = null;
let recordedChunks = [];
let audioBlob = null;
let audioDurationSec = null;

const $ = (id) => document.getElementById(id);

const els = {
  grade: $("grade"),
  age: $("age"),
  textMode: $("textMode"),
  dialect: $("dialect"),
  targetText: $("targetText"),
  teacherNotes: $("teacherNotes"),

  btnRecord: $("btnRecord"),
  btnStop: $("btnStop"),
  audioFile: $("audioFile"),
  audioPlayer: $("audioPlayer"),
  audioMeta: $("audioMeta"),

  modelName: $("modelName"),
  proxyUrl: $("proxyUrl"),
  apiKey: $("apiKey"),
  temperature: $("temperature"),

  btnAnalyze: $("btnAnalyze"),
  btnClear: $("btnClear"),
  status: $("status"),

  report: $("report"),
  reportBadges: $("reportBadges"),
};

/* =========================
   Helpers
========================= */
function setStatus(msg, type = "info") {
  const icons = { info: "ℹ️", ok: "✅", warn: "⚠️", bad: "❌" };
  els.status.textContent = `${icons[type] || "ℹ️"} ${msg}`;
}

function escapeHtml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function countWordsHebrew(text) {
  // מנסה לספור מילים בצורה סבירה גם עם ניקוד/פיסוק.
  // אם תרצה יותר “נוקשה”, אפשר לשנות לרג׳קס אחר.
  const cleaned = (text || "")
    .replace(/[^\p{L}\p{M}\s׳״-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(" ").filter(Boolean).length;
}

async function getAudioDurationSeconds(blob) {
  return new Promise((resolve, reject) => {
    try {
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.preload = "metadata";
      audio.src = url;
      audio.onloadedmetadata = () => {
        const dur = Number.isFinite(audio.duration) ? audio.duration : null;
        URL.revokeObjectURL(url);
        resolve(dur);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
    } catch (e) {
      resolve(null);
    }
  });
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const dataUrl = reader.result; // "data:audio/webm;base64,..."
      const base64 = String(dataUrl).split(",")[1] || "";
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}

function stripJsonFences(text) {
  // Gemini לפעמים מחזיר ```json ... ```
  const t = (text || "").trim();
  if (t.startsWith("```")) {
    return t
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();
  }
  return t;
}

function mkPill(text) {
  const span = document.createElement("span");
  span.className = "pill";
  span.textContent = text;
  return span;
}

/* =========================
   Prompt Builder (MAIN UPGRADE)
========================= */
function buildProfessionalPrompt(payload) {
  const {
    targetText,
    textMode,
    grade,
    age,
    dialect,
    teacherNotes,
    wordCount,
    audioSeconds,
    audioMimeType,
  } = payload;

  const isPointed = textMode === "pointed";

  // ⚠️ הפרומפט כתוב כך ש:
  // 1) יבצע תמלול ויישור מול הטקסט
  // 2) יתן מדדים כמותיים
  // 3) יסווג שגיאות לפי הטקסונומיה שלך
  // 4) יקבע פרופיל קריאה
  // 5) יציע תוכנית עבודה ברמה פרקטית
  // 6) יחזיר JSON נקי (קל לרינדור)
  return `
אתה מומחה להוראה מתקנת ולאבחון קשיי קריאה בעברית, עם התמחות בקריאה קולית, ניקוד, מורפולוגיה ושטף קריאה.
המטרה: לסייע למורה/מאבחנת לבנות תמונת מצב + תוכנית עבודה. אינך רופא ואינך נותן אבחנה רפואית; אם יש צורך בהפניה (ראייה/שמיעה/קשב וכו’) תציין זאת כהמלצה כללית בלבד.
אל תמציא עובדות. אם משהו לא ניתן להסקה מהאודיו ומהטקסט – כתוב במפורש “לא ניתן לקבוע”.

====================
קלט (Input)
====================
- טקסט יעד שהילד היה אמור לקרוא (עברית ${isPointed ? "מנוקדת" : "לא מנוקדת"}):
"""
${targetText}
"""
- פרטים (אם קיימים):
  - כיתה: ${grade || "לא צוין"}
  - גיל: ${age || "לא צוין"}
  - הברה/מבטא: ${dialect || "לא צוין"}
  - הערות מורה: ${teacherNotes || "אין"}
- נתונים טכניים (לחישוב מדדים):
  - מספר מילים בטקסט (ספירה מערכתית): ${wordCount}
  - אורך האודיו (שניות): ${audioSeconds ?? "לא ידוע"}
  - סוג קובץ אודיו: ${audioMimeType || "לא ידוע"}

====================
משימה (מה לעשות בפועל)
====================
1) תמלול מדויק:
   - האזן לאודיו ותמלל את הקריאה בפועל בעברית.
   - שמור סימנים של היסוס/תיקון עצמי/חזרה (למשל: “…” או “[היסוס]”, “[תיקון עצמי]”).
   - אם יש מילה לא ברורה: סמן “[לא ברור]”.

2) יישור (Alignment) מול טקסט היעד:
   - חלק את טקסט היעד לרצף מילים (שמור סדר).
   - עבור כל מילה, נסה לזהות מה נאמר בפועל (או שדלגו/הוסיפו).
   - הפק מערך alignment שבו לכל פריט יש:
     index, expected, spoken, status(OK/ERROR/OMITTED/INSERTED/UNCLEAR), error_types[], severity, notes.

3) סיווג שגיאות איכותני לפי קטגוריות:
   א. שגיאות גרפו-פונמיות (אות/תנועה):
      - שיכול (היפוך סדר)
      - החלפה (אות/ניקוד)
      - הוספה
      - השמטה
   ב. שגיאות מורפולוגיות:
      - בניינים/זמנים/גוף, תחיליות/סופיות
      - שורש (בלבול שורשים)
      - שייכות
      - מש״ה וכל״ב (אותיות שימוש/תחיליות)
      - סמיכות
   ג. עמימות אורתוגרפית / הומוגרפים (בפרט בלא מנוקד)
   ד. שגיאות סמנטיות/תחביריות:
      - פרוזודיה (עצירות לא לפי פיסוק)
      - הטעמה (דגשים/מלעיל-מלרע וכו’ אם נשמע)
      - מילות פונקציה (מילות תפקוד)
      - הפקת משמעות (אם ניתן להסיק מהאודיו/הערות)

   לכל קטגוריה תן:
   - ספירה משוערת (כמה אירועים)
   - דוגמאות קונקרטיות (expected→spoken)
   - הערכת “חומרה”:
     * חמורה: משנה משמעות/פוגעת בהבנה
     * קלה: לא משנה משמעות באופן מובהק

4) מדדים כמותיים:
   - WPM = מספר מילים ÷ (זמן בשניות / 60) — אם זמן ידוע.
   - Accuracy% = 1 − (שגיאות ÷ מילים) × 100 (שגיאה = כל הגה/רכיב שונה, ייתכנו כמה שגיאות במילה).
   - כלל פרקטי: אם הדיוק נמוך מ-85% — אל תציג “שטף” כמסקנה מרכזית; ציין שהשטף לא יציב כי הדיוק עדיין לא מבוסס.
   - תאר גם: היסוסים, תיקון עצמי, קריאה מצרפת/מתרשמת, זמן שהייה בין הברות/מילים (אם ניתן לשמוע).

5) פרופיל קריאה (סיווג):
   קבע פרופיל אחד או שניים (אם יש ערבוב) מתוך:
   - איטי ומדויק
   - מצרף ומדויק
   - מתרשם ומהיר
   - מתרשם ומצרף
   - מתרשם ואיטי
   נמק בקצרה על בסיס מדדים + מאפייני הקריאה.

6) השערות רכיבי-בסיס (פרופיל קוגניטיבי-לשוני) — בלי “אבחון חד משמעי”:
   תן השערה (גבוה/בינוני/נמוך) ל:
   - פונולוגיה (כולל מוקדי מבוכה: שוואים, פתח גנובה, יו״ד מונעת, דגוש/רפה, קמץ קטן וכו’)
   - מורפולוגיה (תבנית/שורש/סמיכות/שייכות/אותיות שימוש)
   - ידע אורתוגרפי לקסיקלי / עמימות
   - שיום מהיר (RAN) / אוטומציה
   לכל רכיב: ראיות מהאודיו + מה עוד כדאי לבדוק (מטלות/תצפיות שהמורה יכולה לאסוף).

7) תוכנית עבודה פרקטית:
   בנה תוכנית ל-2–4 שבועות הקרובים:
   - 3–5 מטרות מדידות (למשל: דיוק 95–98%, שיפור WPM ליעד, ירידה בשגיאות מסוג X)
   - תרגול בכיתה + תרגול בית (קצר, יומי)
   - הצעות פרקטיקות: קריאה חוזרת, קריאה תיאטרלית לשיפור הנגנה, חקירת משפט (פיסוק/מבנה), חקירת מילים (ניקוד/מורפו-אורתוגרפי/עמימות), עבודה על אוצר מילים ואיות — תתאים למה שראית.
   - “מה עושים מחר בבוקר”: 3 צעדים ראשונים מאוד קונקרטיים.

8) המלצות כלליות להפניה/בירור (רק אם יש אינדיקציה):
   - בדיקת ראייה/שמיעה
   - שיחה על קשב/עייפות/מאמץ (אם יש מאמץ גבוה/הימנעות/חרדה)
   תנסח בזהירות ובכבוד.

====================
פורמט פלט (חובה!)
====================
תחזיר *רק* JSON תקין. בלי Markdown. בלי טקסט מסביב. בלי הסברים על הפורמט.

הסכמה (Schema) שאתה חייב לעמוד בה:
{
  "meta": {
    "language": "he",
    "version": "2.0",
    "confidence_overall": 0.0,
    "limitations": []
  },
  "input_summary": {
    "grade": "",
    "age": "",
    "text_mode": "pointed|unpointed",
    "dialect": "",
    "word_count": 0,
    "audio_seconds": 0
  },
  "transcription": {
    "text": "",
    "notes": ""
  },
  "metrics": {
    "wpm": null,
    "accuracy_percent": null,
    "error_events_estimated": null,
    "hesitation_events_estimated": null,
    "self_corrections_estimated": null,
    "interpretation": ""
  },
  "reading_profile": {
    "label": "",
    "secondary_label": "",
    "rationale": ""
  },
  "error_analysis": {
    "totals_by_category": {
      "grapho_phonemic": 0,
      "morphological": 0,
      "orthographic_ambiguity": 0,
      "semantic_syntactic_prosody": 0
    },
    "high_impact_examples": [
      {
        "expected": "",
        "spoken": "",
        "category": "",
        "subtype": "",
        "severity": "minor|major",
        "note": ""
      }
    ]
  },
  "alignment": [
    {
      "index": 0,
      "expected": "",
      "spoken": "",
      "status": "OK|ERROR|OMITTED|INSERTED|UNCLEAR",
      "error_types": [],
      "severity": "minor|major",
      "notes": ""
    }
  ],
  "strengths": [],
  "difficulties": [],
  "hypotheses_components": [
    {
      "component": "phonology|morphology|orthographic_lexical|RAN_automation",
      "likelihood": "low|medium|high",
      "evidence": [],
      "what_to_check_next": []
    }
  ],
  "goals": [
    {
      "domain": "",
      "target": "",
      "success_criteria": "",
      "timeframe_weeks": 0
    }
  ],
  "intervention_plan": {
    "next_session": [],
    "next_2_weeks": [],
    "home_practice": [],
    "teacher_data_to_collect": []
  },
  "referral_flags": {
    "vision_hearing": "",
    "attention_fatigue_emotion": "",
    "other": ""
  }
}

שים לב:
- אם אין audio_seconds — wpm יהיה null ותציין זאת.
- אם אין ביטחון בתמלול/יישור — תעלה את limitations ותוריד confidence_overall.
`.trim();
}

/* =========================
   Gemini API Call
========================= */
async function callGemini({ model, apiKey, proxyUrl, temperature, contents }) {
  const body = {
    contents,
    generationConfig: {
      temperature,
      topP: 0.9,
      maxOutputTokens: 8192,
    },
  };

  // 1) Proxy mode (recommended)
  if (proxyUrl && proxyUrl.trim()) {
    const res = await fetch(proxyUrl.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...body }),
    });
    if (!res.ok) throw new Error(`Proxy error ${res.status}`);
    return await res.json();
  }

  // 2) Direct mode (dev only)
  if (!apiKey || !apiKey.trim()) {
    throw new Error("אין Proxy URL ואין API Key. חייב אחד מהם.");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    encodeURIComponent(model) +
    `:generateContent?key=` +
    encodeURIComponent(apiKey.trim());

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${errText}`);
  }
  return await res.json();
}

/* =========================
   Report Rendering
========================= */
function renderReport(json) {
  els.reportBadges.innerHTML = "";

  const badges = [];
  const wpm = json?.metrics?.wpm;
  const acc = json?.metrics?.accuracy_percent;
  const profile = json?.reading_profile?.label;

  if (profile) badges.push(`פרופיל: ${profile}`);
  if (acc != null) badges.push(`דיוק: ${Math.round(acc)}%`);
  if (wpm != null) badges.push(`WPM: ${Math.round(wpm)}`);

  badges.forEach((b) => els.reportBadges.appendChild(mkPill(b)));

  const sections = [];

  // Summary / transcription
  sections.push(`
    <div class="section">
      <h3>תקציר ותמלול</h3>
      <div class="note"><b>תמלול:</b> ${escapeHtml(json?.transcription?.text || "לא סופק")}</div>
      ${json?.transcription?.notes ? `<div class="note"><b>הערות:</b> ${escapeHtml(json.transcription.notes)}</div>` : ""}
    </div>
  `);

  // Metrics
  const metrics = json?.metrics || {};
  const kv = [
    ["מילים בטקסט", json?.input_summary?.word_count ?? ""],
    ["אורך הקלטה (ש׳)", json?.input_summary?.audio_seconds ?? ""],
    ["WPM", metrics.wpm == null ? "—" : Math.round(metrics.wpm)],
    ["דיוק", metrics.accuracy_percent == null ? "—" : `${Math.round(metrics.accuracy_percent)}%`],
    ["שגיאות (אירועים)", metrics.error_events_estimated ?? "—"],
    ["היסוסים", metrics.hesitation_events_estimated ?? "—"],
    ["תיקון עצמי", metrics.self_corrections_estimated ?? "—"],
    ["הערת פרשנות", metrics.interpretation ?? ""],
  ];

  sections.push(`
    <div class="section">
      <h3>מדדים כמותיים</h3>
      <div class="kv">
        ${kv
          .filter(([k, v]) => v !== "")
          .map(
            ([k, v]) => `
              <div class="item">
                <div class="k">${escapeHtml(String(k))}</div>
                <div class="v">${escapeHtml(String(v))}</div>
              </div>`
          )
          .join("")}
      </div>
    </div>
  `);

  // Error totals table
  const totals = json?.error_analysis?.totals_by_category || {};
  sections.push(`
    <div class="section">
      <h3>ניתוח שגיאות לפי קטגוריות</h3>
      <table class="table">
        <thead>
          <tr>
            <th>קטגוריה</th>
            <th>כמות (משוערת)</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>גרפו-פונמי</td><td>${escapeHtml(String(totals.grapho_phonemic ?? 0))}</td></tr>
          <tr><td>מורפולוגי</td><td>${escapeHtml(String(totals.morphological ?? 0))}</td></tr>
          <tr><td>עמימות אורתוגרפית</td><td>${escapeHtml(String(totals.orthographic_ambiguity ?? 0))}</td></tr>
          <tr><td>סמנטי/תחבירי/פרוזודיה</td><td>${escapeHtml(String(totals.semantic_syntactic_prosody ?? 0))}</td></tr>
        </tbody>
      </table>
    </div>
  `);

  // High impact examples
  const examples = json?.error_analysis?.high_impact_examples || [];
  sections.push(`
    <div class="section">
      <h3>דוגמאות משמעותיות</h3>
      ${
        examples.length
          ? `<table class="table">
              <thead>
                <tr>
                  <th>צפוי</th>
                  <th>נאמר</th>
                  <th>קטגוריה</th>
                  <th>תת-סוג</th>
                  <th>חומרה</th>
                  <th>הערה</th>
                </tr>
              </thead>
              <tbody>
                ${examples
                  .slice(0, 12)
                  .map((e) => `
                    <tr>
                      <td>${escapeHtml(e.expected || "")}</td>
                      <td>${escapeHtml(e.spoken || "")}</td>
                      <td>${escapeHtml(e.category || "")}</td>
                      <td>${escapeHtml(e.subtype || "")}</td>
                      <td>${escapeHtml(e.severity || "")}</td>
                      <td>${escapeHtml(e.note || "")}</td>
                    </tr>
                  `)
                  .join("")}
              </tbody>
            </table>`
          : `<div class="note">לא נשלחו דוגמאות.</div>`
      }
    </div>
  `);

  // Strengths / difficulties
  const strengths = json?.strengths || [];
  const diffs = json?.difficulties || [];
  sections.push(`
    <div class="section">
      <h3>חוזקות ואתגרים</h3>
      <div class="grid" style="grid-template-columns: repeat(2, minmax(0, 1fr)); gap:12px;">
        <div>
          <div class="note"><b>חוזקות</b></div>
          ${strengths.length ? `<ul class="list">${strengths.map(s => `<li>${escapeHtml(String(s))}</li>`).join("")}</ul>` : `<div class="note">—</div>`}
        </div>
        <div>
          <div class="note"><b>אתגרים</b></div>
          ${diffs.length ? `<ul class="list">${diffs.map(s => `<li>${escapeHtml(String(s))}</li>`).join("")}</ul>` : `<div class="note">—</div>`}
        </div>
      </div>
    </div>
  `);

  // Hypotheses
  const hyps = json?.hypotheses_components || [];
  sections.push(`
    <div class="section">
      <h3>השערות רכיבי-בסיס (לא אבחנה רפואית)</h3>
      ${
        hyps.length
          ? `<table class="table">
              <thead>
                <tr>
                  <th>רכיב</th>
                  <th>סבירות</th>
                  <th>ראיות</th>
                  <th>מה לבדוק בהמשך</th>
                </tr>
              </thead>
              <tbody>
                ${hyps.slice(0, 8).map(h => `
                  <tr>
                    <td>${escapeHtml(h.component || "")}</td>
                    <td>${escapeHtml(h.likelihood || "")}</td>
                    <td>${escapeHtml((h.evidence || []).join(" • "))}</td>
                    <td>${escapeHtml((h.what_to_check_next || []).join(" • "))}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>`
          : `<div class="note">לא נשלחו השערות.</div>`
      }
      ${json?.meta?.limitations?.length ? `<div class="note"><b>מגבלות:</b> ${escapeHtml(json.meta.limitations.join(" | "))}</div>` : ""}
    </div>
  `);

  // Plan
  const plan = json?.intervention_plan || {};
  sections.push(`
    <div class="section">
      <h3>תוכנית עבודה</h3>
      <div class="note"><b>מה עושים בשיעור הבא:</b></div>
      ${plan.next_session?.length ? `<ul class="list">${plan.next_session.map(x => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>` : `<div class="note">—</div>`}

      <div class="note"><b>שבועיים קרובים:</b></div>
      ${plan.next_2_weeks?.length ? `<ul class="list">${plan.next_2_weeks.map(x => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>` : `<div class="note">—</div>`}

      <div class="note"><b>תרגול בית:</b></div>
      ${plan.home_practice?.length ? `<ul class="list">${plan.home_practice.map(x => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>` : `<div class="note">—</div>`}

      <div class="note"><b>נתונים לאיסוף ע״י מורה:</b></div>
      ${plan.teacher_data_to_collect?.length ? `<ul class="list">${plan.teacher_data_to_collect.map(x => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>` : `<div class="note">—</div>`}
    </div>
  `);

  // Referral flags
  const rf = json?.referral_flags || {};
  sections.push(`
    <div class="section">
      <h3>דגלים והמלצות זהירות לבירור</h3>
      <ul class="list">
        <li><b>ראייה/שמיעה:</b> ${escapeHtml(rf.vision_hearing || "—")}</li>
        <li><b>קשב/עייפות/רגש:</b> ${escapeHtml(rf.attention_fatigue_emotion || "—")}</li>
        <li><b>אחר:</b> ${escapeHtml(rf.other || "—")}</li>
      </ul>
    </div>
  `);

  els.report.innerHTML = sections.join("");
}

/* =========================
   Audio: record / upload
========================= */
async function startRecording() {
  recordedChunks = [];
  audioBlob = null;
  audioDurationSec = null;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeCandidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    audioBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });

    audioDurationSec = await getAudioDurationSeconds(audioBlob);

    const url = URL.createObjectURL(audioBlob);
    els.audioPlayer.src = url;
    els.audioPlayer.style.display = "block";

    const durTxt = audioDurationSec ? `${audioDurationSec.toFixed(1)} שניות` : "אורך לא ידוע";
    els.audioMeta.innerHTML = `<span class="pill">הוקלט: ${escapeHtml(durTxt)}</span><span class="pill">סוג: ${escapeHtml(audioBlob.type || "unknown")}</span>`;

    setStatus("הקלטה נשמרה.", "ok");
  };

  mediaRecorder.start();
  els.btnRecord.disabled = true;
  els.btnStop.disabled = false;
  setStatus("מקליט... (כן כן, עכשיו שקט בכיתה)", "info");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  els.btnRecord.disabled = false;
  els.btnStop.disabled = true;
}

async function handleAudioFile(file) {
  if (!file) return;
  audioBlob = file;
  audioDurationSec = await getAudioDurationSeconds(audioBlob);

  const url = URL.createObjectURL(audioBlob);
  els.audioPlayer.src = url;
  els.audioPlayer.style.display = "block";

  const durTxt = audioDurationSec ? `${audioDurationSec.toFixed(1)} שניות` : "אורך לא ידוע";
  els.audioMeta.innerHTML = `<span class="pill">נבחר קובץ: ${escapeHtml(durTxt)}</span><span class="pill">סוג: ${escapeHtml(audioBlob.type || "unknown")}</span>`;
  setStatus("קובץ שמע נטען.", "ok");
}

/* =========================
   Analyze
========================= */
async function analyze() {
  const targetText = els.targetText.value.trim();
  if (!targetText) {
    setStatus("חייבים טקסט יעד. אחרת מה ניישר למה—לאוויר?", "warn");
    return;
  }
  if (!audioBlob) {
    setStatus("חייבים הקלטה/קובץ שמע.", "warn");
    return;
  }

  els.btnAnalyze.disabled = true;
  setStatus("שולח לג׳ימיני…", "info");

  try {
    const wordCount = countWordsHebrew(targetText);
    const audioSeconds = audioDurationSec ?? (await getAudioDurationSeconds(audioBlob));
    const audioMimeType = audioBlob.type || "audio/webm";

    const prompt = buildProfessionalPrompt({
      targetText,
      textMode: els.textMode.value,
      grade: els.grade.value.trim(),
      age: els.age.value ? String(els.age.value) : "",
      dialect: els.dialect.value,
      teacherNotes: els.teacherNotes.value.trim(),
      wordCount,
      audioSeconds,
      audioMimeType,
    });

    const audioBase64 = await blobToBase64(audioBlob);

    const contents = [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: audioMimeType,
              data: audioBase64,
            },
          },
        ],
      },
    ];

    const model = els.modelName.value.trim() || "gemini-3-flash-preview";
    const temperature = Number(els.temperature.value ?? 0.2);

    const data = await callGemini({
      model,
      apiKey: els.apiKey.value,
      proxyUrl: els.proxyUrl.value,
      temperature,
      contents,
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) {
      throw new Error("המודל לא החזיר טקסט.");
    }

    const jsonText = stripJsonFences(text);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      // אם זה לא JSON — נציג כטקסט גלמי
      els.reportBadges.innerHTML = "";
      els.report.innerHTML = `
        <div class="section">
          <h3>המודל החזיר תשובה לא-JSON</h3>
          <div class="note">תתקן את הפרומפט/Proxy או תשלח לי את הפלט ואני אסדר לך parsing קשוח יותר.</div>
          <pre style="white-space:pre-wrap; margin:0; font-size:13px; color:#111827;">${escapeHtml(jsonText)}</pre>
        </div>
      `;
      setStatus("התקבלה תשובה, אבל לא בפורמט JSON.", "warn");
      return;
    }

    renderReport(parsed);
    setStatus("הדו״ח מוכן.", "ok");
  } catch (err) {
    console.error(err);
    setStatus(`שגיאה: ${err.message || err}`, "bad");
  } finally {
    els.btnAnalyze.disabled = false;
  }
}

function clearAll() {
  els.targetText.value = "";
  els.teacherNotes.value = "";
  els.grade.value = "";
  els.age.value = "";
  els.textMode.value = "pointed";
  els.dialect.value = "";

  audioBlob = null;
  audioDurationSec = null;
  els.audioPlayer.style.display = "none";
  els.audioPlayer.src = "";
  els.audioMeta.innerHTML = `<span class="pill">אין קובץ שמע עדיין</span>`;
  els.reportBadges.innerHTML = "";
  els.report.innerHTML = `<div class="empty">נוקה. עכשיו תביא תלמיד חדש… או לפחות קפה.</div>`;
  setStatus("נוקה.", "ok");
}

/* =========================
   Wire up
========================= */
els.btnRecord.addEventListener("click", () => startRecording().catch((e) => setStatus(`מיקרופון: ${e.message}`, "bad")));
els.btnStop.addEventListener("click", stopRecording);
els.audioFile.addEventListener("change", (e) => handleAudioFile(e.target.files?.[0]));
els.btnAnalyze.addEventListener("click", analyze);
els.btnClear.addEventListener("click", clearAll);
