#!/usr/bin/env node
/**
 * Freeze the generated stat cards into plain static SVGs.
 *
 * The renderer the workflow uses ships decorative entrance animations: labels
 * start at `opacity: 0` and fade in, bars grow from width 0, and the rank
 * circle's partial arc only exists inside a `@keyframes` rule. A browser plays
 * all of that, but plenty of renderers do not -- static rasterizers leave the
 * labels invisible and the arc as a full ring -- and a committed SVG gets
 * rasterized server side more often than you would think.
 *
 * So before the cards are committed, this script bakes their *final* state in:
 * it copies every keyframe's `to` values onto the elements that animate them,
 * then deletes the animations. What is left renders identically everywhere.
 *
 *   node scripts/freeze-svg.mjs profile/stats.svg profile/top-langs.svg
 */

import { readFile, writeFile } from "node:fs/promises";

/** `@keyframes name { ... }` blocks; bodies nest one level deep only. */
const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** Inline `style="...animation..."` attributes (e.g. animation-delay). */
const INLINE_ANIM = /\s+style="[^"]*animation[^"]*"/g;

/** `animation: ...;` / `animation-delay: ...;` declarations. */
const ANIM_DECL = /\s*animation(?:-[\w-]+)?:[^;{}]+;/g;

/** `opacity: 0;` only; keeps opacity: 0.2 and friends. */
const OPACITY_ZERO = /opacity:\s*0\s*;/g;

/**
 * Read each `to { ... }` block of a keyframe rule.
 * @returns {Map<string, Map<string, string>>} keyframe name -> property -> value
 */
function readKeyframes(css) {
  const finals = new Map();
  for (const match of css.matchAll(KEYFRAMES)) {
    const [, name, body] = match;
    const to = /to\s*\{([^}]*)\}/.exec(body);
    if (!to) continue;
    const props = new Map();
    for (const decl of to[1].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      props.set(decl[1].trim(), decl[2].trim());
    }
    finals.set(name, props);
  }
  return finals;
}

export function freeze(svg) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg);
  if (!style) return svg;

  const finals = readKeyframes(style[1]);

  // Bake each animation's end state onto the selector it animated.
  let css = style[1];
  const applyFinals = (selector, props) => {
    // Find every element whose class matches the animated selector and set the
    // final values as presentation attributes, which every renderer honours.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    svg = svg.replace(
      new RegExp(`(<[^>]*class="[^"]*\\b${escaped}\\b[^"]*"[^>]*?)(\\s*/?>)`, "g"),
      (_all, head, close) => {
        let attrs = head;
        for (const [prop, value] of props) {
          if (new RegExp(`${prop}="`).test(attrs)) continue;
          attrs += ` ${prop}="${value}"`;
        }
        return attrs + close;
      },
    );
    // Selectors that are not classes (e.g. `#rect-mask rect`) keep their
    // static attributes already; their keyframes are dropped below.
    void css;
  };

  for (const [name, props] of finals) {
    // Which selector animates this keyframe?
    const rule = new RegExp(`([^{}]+)\\{[^}]*animation:\\s*${name}\\b[^;}]*;?[^}]*\\}`, "g");
    for (const match of css.matchAll(rule)) {
      const selector = match[1].trim();
      const className = /\.([\w-]+)/.exec(selector);
      if (className) applyFinals(className[1], props);
    }
  }

  // Drop the animations now that their end state is baked in.
  css = css
    .replace(KEYFRAMES, "")
    .replace(ANIM_DECL, "")
    .replace(OPACITY_ZERO, "");

  return svg.replace(/<style>[\s\S]*?<\/style>/, `<style>${css}</style>`).replace(INLINE_ANIM, "");
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/freeze-svg.mjs <card.svg>...");
  process.exit(1);
}

for (const path of paths) {
  const before = await readFile(path, "utf8");
  const after = freeze(before);
  await writeFile(path, after, "utf8");
  console.log(`froze ${path} (${before.length} -> ${after.length} bytes)`);
}
