#!/usr/bin/env node
/**
 * Render the contribution streak card as a static SVG.
 *
 * The profile used to load this card from streak-stats.demolab.com, a shared
 * host. That host parses GitHub's contribution calendar as a grid of SVG
 * <rect> elements, but GitHub now renders the calendar as <td> cells, and the
 * shared host is rate limited on top of that -- which is why the card started
 * coming back as a broken image.
 *
 * This script reads the same calendar GitHub itself publishes and writes the
 * card into the repo, so the README no longer depends on a host anyone else
 * controls. It needs no secret: the contributions endpoint is public, and the
 * workflow's GITHUB_TOKEN is used only for the account start date.
 *
 *   node scripts/streak-svg.mjs Mascottz profile/streak.svg
 *
 * Card geometry and colour keys follow DenverCoder1/github-readme-streak-stats
 * (495x195, three equal columns, ring around the current streak) so the card
 * reads the same as the one it replaces.
 *
 * On any failure this exits non-zero *without* writing the file, so the
 * workflow aborts its commit and the last good card stays on the profile
 * instead of being replaced by an error card.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const UA = "Mascottz-profile-readme/1.0 (+https://github.com/Mascottz/Mascottz)";

const die = (message) => {
  console.error(`::error::streak-svg: ${message}`);
  process.exit(1);
};

/** Fetch with a timeout and a UA that GitHub's HTML endpoint accepts. */
async function get(url, { accept = "text/html,*/*", authorization } = {}) {
  const headers = { "user-agent": UA, accept };
  if (authorization) headers.authorization = authorization;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(45_000),
    redirect: "follow",
  });
  if (!response.ok) die(`GET ${url} -> HTTP ${response.status}`);
  return response.text();
}

/**
 * Parse the yearly contribution calendar.
 * @returns {{days: Array<{date: string, count: number}>, totalInYear: number}}
 */
function parseCalendar(html) {
  const totalMatch = /([\d,]+)\s+contributions\s+in the last year/i.exec(
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
  );
  if (!totalMatch) die("could not find the yearly contribution total; GitHub may have changed the markup");

  // Each day is a gridcell carrying both its ISO date and its id; the exact
  // count lives in the <tool-tip> that points at that id.
  const idToDate = new Map();
  for (const m of html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*?id="(contribution-day-[^"]+)"/g)) {
    idToDate.set(m[2], m[1]);
  }
  if (idToDate.size < 300) die(`only found ${idToDate.size} calendar days; refusing to trust this parse`);

  const idToCount = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*?for="(contribution-day-[^"]+)"[\s\S]{0,500}?>([\s\S]*?)<\/tool-tip>/g)) {
    const text = m[2].replace(/\s+/g, " ").trim();
    const count = /^(\d+)\s+contributions?\s+on/i.exec(text);
    idToCount.set(m[1], count ? Number(count[1]) : 0);
  }

  const days = [...idToDate.entries()]
    .map(([id, date]) => ({ date, count: idToCount.get(id) ?? 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { days, totalInYear: Number(totalMatch[1].replace(/,/g, "")) };
}

/** "Nov 16" inside the current year, "2025 Nov 16" before it (upstream format). */
function formatDate(iso, thisYear) {
  const [year, month, day] = iso.split("-").map(Number);
  const when = `${MONTHS[month - 1]} ${day}`;
  return year === thisYear ? when : `${year} ${when}`;
}

function streaks(days) {
  let longest = { length: 0, start: null, end: null };
  let run = null;
  for (const { date, count } of days) {
    if (count > 0) {
      if (!run) run = { start: date, length: 0 };
      run.length += 1;
      run.end = date;
      if (run.length > longest.length) longest = { ...run };
    } else {
      run = null;
    }
  }

  // A streak survives today having no contributions yet, but not a whole empty
  // day: if both today and yesterday are zero the streak is genuinely over.
  let current = { length: 0, start: null, end: null };
  run = null;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const { date, count } = days[i];
    if (count > 0) {
      if (!run) run = { start: date, end: date, length: 0 };
      run.length += 1;
      run.start = date;
    } else if (i === days.length - 1 || i === days.length - 2) {
      continue;
    } else {
      break;
    }
  }
  if (run) current = run;

  return { longest, current };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCard({ total, totalRange, current, currentRange, longest, longestRange, colors }) {
  const WIDTH = 495;
  const HEIGHT = 195;
  const COLUMN = WIDTH / 3;
  const BAR_TOP = 28;
  const BAR_BOTTOM = 170;
  const RING_RADIUS = 40;
  const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif";

  // x centres of the three columns: Total Contributions | Current Streak | Longest Streak
  const [totalX, currentX, longestX] = [0.5, 1.5, 2.5].map((n) => COLUMN * n);

  const number = (x, y, text, fill, size, weight) =>
    `    <g transform="translate(${x}, ${y})">
      <text x="0" y="32" text-anchor="middle" fill="#${fill}" font-family="${FONT}" font-weight="${weight}" font-size="${size}">${escapeXml(text)}</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" role="img" aria-labelledby="streakTitle streakDesc">
  <title id="streakTitle">Contribution streak</title>
  <desc id="streakDesc">${escapeXml(total)} contributions. Current streak ${escapeXml(current)} days. Longest streak ${escapeXml(longest)} days.</desc>
  <style>
    .label { font: 400 14px ${FONT}; fill: #${colors.sideLabels} }
    .date  { font: 400 12px ${FONT}; fill: #${colors.dates} }
  </style>

  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="4.5" fill="#${colors.background}" stroke="#${colors.border}"/>

  <line x1="${COLUMN}" y1="${BAR_TOP}" x2="${COLUMN}" y2="${BAR_BOTTOM}" stroke="#${colors.stroke}" stroke-width="1"/>
  <line x1="${COLUMN * 2}" y1="${BAR_TOP}" x2="${COLUMN * 2}" y2="${BAR_BOTTOM}" stroke="#${colors.stroke}" stroke-width="1"/>

  <!-- total contributions -->
${number(totalX, 48, total, colors.sideNums, "28px", "700")}
${number(totalX, 84, "Total Contributions", colors.sideLabels, "14px", "400")}
${number(totalX, 114, totalRange, colors.dates, "12px", "400")}

  <!-- current streak: number inside the ring, then label, then range -->
  <circle cx="${currentX}" cy="71" r="${RING_RADIUS}" fill="none" stroke="#${colors.ring}" stroke-width="5"/>
${number(currentX, 48, current, colors.fire, "28px", "700")}
${number(currentX, 108, "Current Streak", colors.currStreakLabel, "14px", "400")}
${number(currentX, 145, currentRange, colors.dates, "12px", "400")}

  <!-- longest streak -->
${number(longestX, 48, longest, colors.sideNums, "28px", "700")}
${number(longestX, 84, "Longest Streak", colors.sideLabels, "14px", "400")}
${number(longestX, 114, longestRange, colors.dates, "12px", "400")}
</svg>
`;
}

async function main() {
  const username = process.argv[2] || process.env.GITHUB_REPOSITORY_OWNER;
  const outPath = process.argv[3] || "profile/streak.svg";
  if (!username) die("usage: node scripts/streak-svg.mjs <username> <out.svg>");

  const html = await get(`https://github.com/users/${encodeURIComponent(username)}/contributions`);
  const { days, totalInYear } = parseCalendar(html);

  const lastDate = days[days.length - 1].date;
  const thisYear = Number(lastDate.slice(0, 4));
  const { longest, current } = streaks(days);

  // The card's left column is lifetime contributions, so its range starts at
  // the day the account was created. Public endpoint; the token only lifts the
  // rate limit.
  let since = days[0].date;
  try {
    const profile = JSON.parse(
      await get(`https://api.github.com/users/${encodeURIComponent(username)}`, {
        accept: "application/vnd.github+json",
        authorization: process.env.GITHUB_TOKEN ? `Bearer ${process.env.GITHUB_TOKEN}` : undefined,
      }),
    );
    if (profile?.created_at) since = profile.created_at.slice(0, 10);
  } catch {
    console.log(`::warning::could not read the account start date; falling back to ${since}`);
  }

  const fmt = (iso) => formatDate(iso, thisYear);
  const range = (start, end) => (start === end ? fmt(start) : `${fmt(start)} - ${fmt(end)}`);

  const svg = renderCard({
    total: totalInYear.toLocaleString("en-US"),
    totalRange: `${formatDate(since, thisYear)} - Present`,
    current: String(current.length),
    currentRange: current.length ? range(current.start, current.end) : "No current streak",
    longest: String(longest.length),
    longestRange: range(longest.start, longest.end),
    colors: {
      background: "0D1A15",
      border: "24382E",
      stroke: "24382E",
      ring: "C98E5F",
      fire: "E2794F",
      currStreakLabel: "ECE7DB",
      sideLabels: "ECE7DB",
      sideNums: "9FB6A7",
      dates: "9FB6A7",
    },
  });

  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, svg, "utf8");

  console.log(
    `wrote ${outPath}: total=${totalInYear} current=${current.length} (${current.start}..${current.end}) longest=${longest.length} (${longest.start}..${longest.end})`,
  );
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error));
});
