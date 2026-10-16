import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Routine, RoutineRun } from "@shared/contracts";
import { RoutineDefinitionCard, RoutineRunItem, RoutinesSettingsPanel, RoutineTargetFields } from "./RoutinesSettingsPanel";

type TargetProps = Parameters<typeof RoutineTargetFields>[0];
const members = [{ id: "alice", name: "策划" }, { id: "bob", name: "编辑" }];
const choice: TargetProps["choices"][number] = {
  key: "room:team", label: "群聊 · 内容团队", target: { kind: "room", roomId: "team", sessionId: "room-main", routingMode: "everyone", targetBotIds: members.map(member => member.id), expectedMembershipVersion: 7 },
  generation: 2, membershipVersion: 7, profileVersions: members.map(member => ({ botId: member.id, version: 3 })), members,
};
const routine: Routine = {
  id: "rule", name: "每日选题", prompt: "整理三个候选", botId: null, target: choice.target,
  targetSnapshot: { ...choice, scopeVersion: 4, resourceRefs: [], mediaRefs: [], admissionDigest: "fixed" },
  enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 }, nextRunAt: null, version: 9,
  createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
};
function targetProps(overrides: Partial<TargetProps> = {}): TargetProps {
  return { choices: [choice], review: choice, busy: false, onSelect: vi.fn(), onReviewChange: vi.fn(), onReselect: vi.fn(), ...overrides };
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : []);
}
function input(tree: ReactNode, label: string): ReactElement<Record<string, unknown>> {
  const result = elements(tree).find(element => element.props["aria-label"] === label);
  if (!result) throw new Error(`Missing control ${label}`);
  return result;
}
function renderCard(choices = [choice], saved = routine): string {
  return renderToStaticMarkup(<RoutineDefinitionCard routine={saved} choices={choices} busy={false} onEdit={() => {}} onRun={() => {}} onToggle={() => {}} onRemove={() => {}} />);
}
function run(state: RoutineRun["state"]): RoutineRun {
  return { id: "run", routineId: routine.id, routineName: routine.name, botId: null, version: 5, batchId: "batch", targetSnapshot: routine.targetSnapshot, promptSnapshot: routine.prompt, scheduleSnapshot: routine.schedule, trigger: "event", triggerKey: "event:1", scheduledFor: 0, state, clientNonce: "nonce", runtimeRunId: null, lastErrorCode: null, createdAt: routine.createdAt, startedAt: null, finishedAt: null };
}

describe("Routine MAIN targets and immutable run controls", () => {
  it("offers MAIN targets and explains paused creation without claiming a run occurred", () => {
    const html = renderToStaticMarkup(<RoutinesSettingsPanel active />);
    expect(html).toContain('aria-label="Routine 执行目标"');
    expect(html).toContain("仅 Bot / 群聊主会话");
    expect(html).toContain("创建为暂停状态");
    expect(html).toContain("尚无运行记录");
    expect(html).not.toContain("TASK");
    expect(html).not.toContain("autofocus");
  });
  it("defaults Everyone to the reviewed fixed roster with all member checkboxes locked", () => {
    const html = renderToStaticMarkup(<RoutineTargetFields {...targetProps()} />);
    expect(html).toContain('<option value="everyone" selected="">Everyone');
    for (const member of members) expect(html).toMatch(new RegExp(`aria-label="Routine 成员 ${member.name}"[^>]*disabled=""[^>]*checked=""`));
    expect(html).toContain("已审阅成员版本：v7");
    expect(html).toContain("后来加入的成员不会自动执行");
  });
  it("changes only the explicit selected cohort and retains the reviewed membership version", () => {
    const onReviewChange = vi.fn(), props = targetProps({ onReviewChange });
    const tree = RoutineTargetFields(props);
    const routing = input(tree, "Routine 群聊路由");
    (routing.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "explicit" } });
    const selected = onReviewChange.mock.calls[0]![0] as NonNullable<TargetProps["review"]>;
    expect(selected.target).toMatchObject({ routingMode: "explicit", targetBotIds: ["alice", "bob"], expectedMembershipVersion: 7 });
    onReviewChange.mockClear();
    const checkbox = input(RoutineTargetFields({ ...props, review: selected }), "Routine 成员 编辑");
    (checkbox.props.onChange as () => void)();
    expect(onReviewChange).toHaveBeenCalledWith(expect.objectContaining({ membershipVersion: 7, target: expect.objectContaining({ routingMode: "explicit", targetBotIds: ["alice"], expectedMembershipVersion: 7 }) }));
    expect(choice.target.kind === "room" && choice.target.targetBotIds).toEqual(["alice", "bob"]);
  });
  it("retains a saved roster when a member joins and requires explicit review before run or enable", () => {
    const changed = { ...choice, membershipVersion: 8, members: [...members, { id: "new", name: "新增成员" }] };
    const html = renderCard([changed]);
    expect(html).toContain("固定名单（Everyone）：策划、编辑 · 保存时成员版本 v7");
    expect(html).not.toContain("新增成员");
    expect(html).toContain("请编辑并重新选择目标后保存");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>立即运行<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>启用<\/button>/);
    const fields = renderToStaticMarkup(<RoutineTargetFields {...targetProps({ choices: [changed] })} />);
    expect(fields).toMatch(/<fieldset[^>]*disabled=""/);
    expect(fields).toContain("当前草稿已保留");
    expect(fields).toContain("重新选择并审阅目标");
  });
  it("detects remove/readd and selected Bot profile revisions even when displayed names match", () => {
    expect(renderCard([{ ...choice, membershipVersion: 9 }])).toContain("请编辑并重新选择目标后保存");
    expect(renderCard([{ ...choice, profileVersions: [{ botId: "alice", version: 4 }, choice.profileVersions[1]!] }])).toContain("请编辑并重新选择目标后保存");
    expect(renderCard()).not.toContain("请编辑并重新选择目标后保存");
    expect(renderCard()).toContain("定义 v9");
  });
  it("blocks a revoked admission until a fresh explicit target review even if visible membership is unchanged", () => {
    const html = renderToStaticMarkup(<RoutineTargetFields {...targetProps({ requiresReselection: true })} />);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("请重新选择目标、核对成员，再保存");
    expect(html).toContain("已审阅成员版本：v7");
  });
  it("detects a cleared MAIN generation but allows unrelated profile changes outside an explicit subset", () => {
    expect(renderCard([{ ...choice, generation: 3 }])).toContain("请编辑并重新选择目标后保存");
    const target = { ...choice.target, kind: "room" as const, roomId: "team", routingMode: "explicit" as const, targetBotIds: ["alice"], expectedMembershipVersion: 7 };
    const selected = { ...routine, target, targetSnapshot: { ...routine.targetSnapshot, target, profileVersions: [choice.profileVersions[0]!] } };
    const changedOther = { ...choice, profileVersions: [choice.profileVersions[0]!, { botId: "bob", version: 99 }] };
    expect(renderCard([changedOther], selected)).not.toContain("请编辑并重新选择目标后保存");
  });
  it("keeps pause available on a stale enabled definition while blocking a fresh run", () => {
    const html = renderCard([{ ...choice, membershipVersion: 10 }], { ...routine, enabled: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>立即运行<\/button>/);
    expect(html).toMatch(/<button class="secondary-button" type="button">暂停<\/button>/);
  });
  it.each(["queued", "waiting", "dispatching", "running"] as const)("allows cancellation only for an admitted active %s run", state => {
    const onCancel = vi.fn(), tree = RoutineRunItem({ run: run(state), busy: false, onCancel });
    const button = input(tree, "取消 Routine 运行 每日选题");
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)(); expect(onCancel).toHaveBeenCalledTimes(1);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("事件触发");
    expect(html).not.toContain("已完成");
  });
  it.each(["cancel-requested", "completed", "failed", "cancelled", "missed", "unknown"] as const)("does not offer cancellation or resend for %s", state => {
    const html = renderToStaticMarkup(<RoutineRunItem run={run(state)} busy={false} onCancel={() => {}} />);
    expect(html).not.toContain("取消本次运行"); expect(html).not.toContain("重试");
    if (state === "cancel-requested") expect(html).toContain("正在取消");
    if (state === "unknown") { expect(html).toContain("结果未知"); expect(html).toContain("请先核验实际执行情况"); }
  });
  it("preserves disabled controls while the exact host mutation is pending", () => {
    const html = renderToStaticMarkup(<RoutineRunItem run={run("running")} busy onCancel={() => {}} />);
    expect(html).toMatch(/aria-label="取消 Routine 运行 每日选题"[^>]*>取消本次运行/);
    expect(html).toContain('disabled=""');
  });
});
