#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
});
if (listed.status !== 0) {
  process.stderr.write(listed.stderr);
  process.exit(listed.status ?? 1);
}

const rules = [
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
];

const findings = [];
for (const file of listed.stdout.split("\0").filter(Boolean)) {
  let source;
  try {
    source = readFileSync(file);
  } catch {
    continue;
  }
  if (source.includes(0)) continue;
  const text = source.toString("utf8");
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line} ${rule.name}`);
    }
  }
}

if (findings.length) {
  console.error("Potential committed secrets found:");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error("Remove the value and rotate it if it was ever valid.");
  process.exit(1);
}

console.log(`Secret patterns: clean (${rules.length} rules)`);
