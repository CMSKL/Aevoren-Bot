import { describe, expect, it } from "vitest";
import { workspaceRelativePathSchema, workspaceToolRequestSchema } from "@shared/schemas";
import { requestedWritePaths } from "./workspace-write-requirements";

describe("explicit workspace write requirements", () => {
  it.each<[string, string[]]>([
    ["真实读取当前工作区中的 LICENSE.md，提取许可证名称和第一段摘要，新建文件 license-note.md 并写入这两项内容。仅在允许的工作区内操作，不联网、不发布，不创建其他文件。完成后报告 license-note.md 的真实文件路径与写入内容概要。", ["license-note.md"]],
    ["真实读取 license-note.md 和 USER_GUIDE.md，从 USER_GUIDE.md 中整理出该产品的三个用途，新建文件 guide-note.md 并写入这三个用途。仅在允许的工作区内操作，不联网、不发布，不创建其他文件。完成后报告 guide-note.md 的真实文件路径与内容概要。", ["guide-note.md"]],
    ["许可证研究员先真实读取当前工作区的 LICENSE.md，将许可证名称和第一段摘要新建为 license-note.md；然后发布编辑真实读取 license-note.md 和 USER_GUIDE.md，将该产品的三个用途整理为 guide-note.md。", ["license-note.md", "guide-note.md"]],
    ["把许可证名称写入license-note.md；把三个用途整理进guide-note.md。", ["license-note.md", "guide-note.md"]],
    ["请保存 report.md。", ["report.md"]],
    ["读取 source.md，保存为 docs/result.md。", ["docs/result.md"]],
    ["将 SOURCE.md 摘要保存到 output.md。", ["output.md"]],
    ["将不同版本的摘要保存为 output.md。", ["output.md"]],
    ["写入 report.md，保存后读取 report.md 核验。", ["report.md"]],
    ["新建 `报告 一.md`，再输出“资料目录/中文 报告.csv”。", ["报告 一.md", "资料目录/中文 报告.csv"]],
    ["生成一份 Markdown 文件 'reports/final result.md'。", ["reports/final result.md"]],
    ["创建a.md和b.md。", ["a.md", "b.md"]],
    ["输出 a.md、b.csv 和 `c d.md`。", ["a.md", "b.csv", "c d.md"]],
    ["Write result.md.", ["result.md"]],
    ["Read SOURCE.md and write a summary to notes/result.md.", ["notes/result.md"]],
    ["Write a summary of SOURCE.md to output.md.", ["output.md"]],
    ["Save SOURCE.md as output.md.", ["output.md"]],
    ["Create a new file named `my report.md` from SOURCE.md.", ["my report.md"]],
    ["Create output.md and summary.csv from SOURCE.md.", ["output.md", "summary.csv"]],
    ["Use workspace_write workspaceId=abc path=license-note.md to write the result.", ["license-note.md"]],
    ["写入 `cafe\u0301.md`；再次保存 `café.md`。", ["café.md"]],
    ["请写入“报告.md”，不要写入 secret.md。", ["报告.md"]],
    ["不要读取 secret.md，只创建 public.md。", ["public.md"]],
    ["不要写入 secret.md；请创建 public.md。", ["public.md"]],
    ["Do not write secret.md. Create public.md instead.", ["public.md"]],
    ["Don't write secret.md; save public.md.", ["public.md"]],
    ["不要生成 secret.md。", []],
    ["不创建 secret.md。", []],
    ["无需保存 secret.md。", []],
    ["Never create secret.md.", []],
    ["Avoid writing a file; do not save secret.md.", []],
    ["已经写入 report.md。", []],
    ["Already saved report.md.", []],
    ["例如：写入 example.md，然后生成 another.md。", []],
    ["请解释如何新建 report.md，不要执行。", []],
    ["说明写入 report.md 的操作步骤。", []],
    ["文档中写着保存 report.md，请说明这句话。", []],
    ["Explain `write report.md` without executing it.", []],
    ["请解释“新建文件 report.md”的含义。", []],
    ["引用：保存 report.md。", []],
    ["> Create quoted.md\n请创建 actual.md。", ["actual.md"]],
    ["代码示例：```\nwrite sample.md\n```\n请创建 actual.md。", ["actual.md"]],
    ["~~~js\nsave('sample.md')\n~~~\n新建 actual.md。", ["actual.md"]],
    ["读取 LICENSE.md 和 USER_GUIDE.md 后报告结果。", []],
    ["生成 SOURCE.md 的摘要。", []],
    ["输出 report.md 的路径。", []],
    ["Write a report based on SOURCE.md.", []],
    ["阅读 https://example.com/source.md 并输出 output.md。", ["output.md"]],
    ["创建 /tmp/report.md。", []],
    ["写入 ../report.md。", []],
    ["保存 docs/../report.md。", []],
    ["写入 `docs\\report.md`。", []],
    ["新建 `bad\tname.md`。", []],
  ])("extracts only affirmative named outputs from %s", (text, expected) => {
    expect(requestedWritePaths(text)).toEqual(expected);
  });
});

describe("workspace path control characters", () => {
  it.each([...Array.from({ length: 32 }, (_, code) => code), 127])("rejects ASCII control character %i", (code) => {
    const path = `notes/bad${String.fromCharCode(code)}name.md`;
    expect(workspaceRelativePathSchema.safeParse(path).success).toBe(false);
    expect(workspaceToolRequestSchema.safeParse({ kind: "workspace-write", workspaceId: crypto.randomUUID(), path, content: "test" }).success).toBe(false);
  });

  it("rejects the observed malformed Claude path while preserving Chinese names and spaces", () => {
    expect(workspaceRelativePathSchema.safeParse("\n   .md").success).toBe(false);
    expect(workspaceRelativePathSchema.parse("中文目录/报告 一.md")).toBe("中文目录/报告 一.md");
    expect(workspaceRelativePathSchema.parse(" leading and trailing .md ")).toBe(" leading and trailing .md ");
    expect(workspaceRelativePathSchema.parse("cafe\u0301.md")).toBe("café.md");
    expect(workspaceRelativePathSchema.parse("")).toBe("");
  });
});
