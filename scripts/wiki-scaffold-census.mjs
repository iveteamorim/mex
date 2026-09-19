#!/usr/bin/env node
/**
 * Shape census of a `.mex` scaffold — counts and distributions only.
 *
 * §6a condition 2 of the implementation plan: the synthesized migration corpus
 * is generated to match a census of a real scaffold, and **only numbers ever
 * enter the repo**. So this prints histograms and frequencies and nothing else:
 * no file names, no heading text, no prose, no key names outside a fixed
 * allowlist. A user-chosen frontmatter key is itself identifying, so anything
 * off the allowlist is bucketed as `other`.
 *
 * Writes nothing. Reads the path given on the command line.
 *
 *   node scripts/wiki-scaffold-census.mjs <scaffold-path> [> census.json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** The only frontmatter keys whose names may appear in committed output. */
const KEY_ALLOWLIST = ["name", "description", "triggers", "edges", "grounds_to", "last_updated", "mex"];

/** Directory buckets. A path outside these is `other`, never reproduced. */
const DIRECTORY_BUCKETS = ["root", "context", "patterns", "other"];

function walk(root, directory, out) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(root, absolute, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(absolute);
    }
  }
  return out;
}

function bucketOf(relativePath) {
  const parts = relativePath.split(sep);
  if (parts.length === 1) return "root";
  if (DIRECTORY_BUCKETS.includes(parts[0])) return parts[0];
  return "other";
}

function frontmatterOf(text) {
  if (!text.startsWith("---")) return { keys: [], value: null };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { keys: [], value: null };
  const inner = text.slice(text.indexOf("\n") + 1, end + 1);
  try {
    const value = parseYaml(inner);
    return { keys: value !== null && typeof value === "object" ? Object.keys(value) : [], value };
  } catch {
    return { keys: [], value: null, malformed: true };
  }
}

/** Headings outside fenced code, by depth. Text is counted, never recorded. */
function headingsOf(text) {
  const depths = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,6})\s+\S/.exec(line);
    if (match !== null) depths.push(match[1].length);
  }
  return depths;
}

function bump(histogram, key) {
  histogram[key] = (histogram[key] ?? 0) + 1;
}

/** Prose length in lines, bucketed coarsely so no file is identifiable by size. */
function proseBucket(lines) {
  if (lines < 10) return "under-10";
  if (lines < 30) return "10-29";
  if (lines < 80) return "30-79";
  if (lines < 200) return "80-199";
  return "200-plus";
}

/**
 * The provenance block, emitted rather than hand-written.
 *
 * It used to live only in the committed `census.json`, which made the
 * documented refresh command destroy the thing it exists to update: piping
 * this script over the file replaced a census marked `realScaffoldCensus:
 * true` with one that had no provenance at all, and the corpus test skips
 * `provenance` when comparing, so nothing failed. A census that cannot say
 * where it came from is a census nobody can trust twice.
 */
function provenanceFor(fileCount) {
  return {
    realScaffoldCensus: true,
    // Deliberately no path, no directory name and no project name: the
    // argument this script was given is itself identifying, and mex is public.
    source: `a real filled pre-wiki scaffold on the maintainer's machine, ${fileCount} files. Numbers only.`,
    takenAt: new Date().toISOString().slice(0, 10),
    refresh:
      "node scripts/wiki-scaffold-census.mjs <scaffold-path> > test/fixtures/wiki-migration/census.json, " +
      "then node scripts/generate-wiki-migration-corpus.mjs to regenerate tier 1 against it. " +
      "Only numbers ever enter this repo (plan section 6a).",
    note:
      "Numbers only. No file name, heading, prose, or user-chosen frontmatter key from any real " +
      "scaffold appears here or in the generated corpus: directory names are bucketed against a " +
      "closed list and key names against a closed allowlist, with everything else counted as `other`.",
  };
}

export function censusOf(root) {
  const files = walk(root, root, []);
  const census = {
    schema: 1,
    provenance: provenanceFor(files.length),
    fileCount: files.length,
    filesByBucket: {},
    headingDepthHistogram: {},
    headingsPerFileHistogram: {},
    edgesPerFileHistogram: {},
    edgeConditionRate: { withCondition: 0, without: 0 },
    triggersPerFileHistogram: {},
    proseLengthBuckets: {},
    frontmatterKeyFrequency: {},
    filesWithFrontmatter: 0,
    filesWithMalformedFrontmatter: 0,
    filesWithRootGroundsTo: 0,
    groundingsPerFileHistogram: {},
    filesWithMexKey: 0,
    inlineAnchorCount: 0,
    crlfFileCount: 0,
    bomFileCount: 0,
  };

  for (const absolute of files) {
    const text = readFileSync(absolute, "utf-8");
    const relativePath = relative(root, absolute);
    bump(census.filesByBucket, bucketOf(relativePath));
    if (text.includes("\r\n")) census.crlfFileCount += 1;
    if (text.charCodeAt(0) === 0xfeff) census.bomFileCount += 1;

    const { keys, value, malformed } = frontmatterOf(text);
    if (malformed === true) census.filesWithMalformedFrontmatter += 1;
    if (keys.length > 0) census.filesWithFrontmatter += 1;
    for (const key of keys) bump(census.frontmatterKeyFrequency, KEY_ALLOWLIST.includes(key) ? key : "other");

    const edges = Array.isArray(value?.edges) ? value.edges : [];
    bump(census.edgesPerFileHistogram, String(edges.length));
    for (const edge of edges) {
      if (edge !== null && typeof edge === "object" && typeof edge.condition === "string") census.edgeConditionRate.withCondition += 1;
      else census.edgeConditionRate.without += 1;
    }

    const triggers = Array.isArray(value?.triggers) ? value.triggers : [];
    bump(census.triggersPerFileHistogram, String(triggers.length));

    const groundings = Array.isArray(value?.grounds_to) ? value.grounds_to : [];
    if (groundings.length > 0) census.filesWithRootGroundsTo += 1;
    bump(census.groundingsPerFileHistogram, String(groundings.length));
    if (keys.includes("mex")) census.filesWithMexKey += 1;

    const depths = headingsOf(text);
    for (const depth of depths) bump(census.headingDepthHistogram, String(depth));
    bump(census.headingsPerFileHistogram, String(depths.length));
    bump(census.proseLengthBuckets, proseBucket(text.split(/\r?\n/).length));
    census.inlineAnchorCount += (text.match(/\]\(mex:\/\//g) ?? []).length;
  }

  return census;
}

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: node scripts/wiki-scaffold-census.mjs <scaffold-path>");
  process.exit(2);
}
if (!statSync(target).isDirectory()) {
  console.error(`${target} is not a directory`);
  process.exit(2);
}
console.log(JSON.stringify(censusOf(target), null, 2));
