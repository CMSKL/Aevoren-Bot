#!/usr/bin/env node

if (process.argv.includes("--version")) {
  process.stdout.write("ollama version is 0.31.1-fixture\n");
  process.exit(0);
}

if (process.argv[2] === "list") {
  process.stdout.write("NAME              ID              SIZE      MODIFIED\n");
  process.stdout.write("fixture-ollama    abcdef123456    1.0 GB    now\n");
  process.exit(0);
}

if (process.argv[2] === "ps") {
  process.stdout.write("NAME              ID              SIZE      PROCESSOR    UNTIL\n");
  process.stdout.write("fixture-ollama    abcdef123456    1.0 GB    100% CPU     4 minutes\n");
  process.exit(0);
}

if (process.argv[2] !== "run" || process.argv[3] !== "fixture-ollama") process.exit(2);
if (!process.argv.includes("--think=false") || !process.argv.includes("--nowordwrap")) process.exit(4);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.includes("[user]")) process.exit(3);
  process.stdout.write("Ollama reply");
});
