import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventDelivery } from "@shared/event-contracts";
import { AutomationEventReceipt, AutomationEventsPanel } from "./AutomationEventsPanel";
describe("event management entry and truthful receipts", () => {
  it("starts with an explicit stopped listener and no inherited Routine target", () => {
    const html = renderToStaticMarkup(<AutomationEventsPanel active={false} />);
    expect(html).toContain("监听已停止"); expect(html).toContain("启动本机监听"); expect(html).toContain("选择并审阅已启用的 Routine"); expect(html).toContain("不可信 JSON 附件"); expect(html).not.toContain("Bearer token</");
  });
  it("keeps unknown acceptance distinct from an actual dispatch receipt", () => {
    const delivery = { state: "unknown", eventId: "one", subscriptionVersion: 2, routineVersion: 3, payloadDigest: "opaque", routineRunId: null, errorCode: null } as EventDelivery;
    const unknown = renderToStaticMarkup(<AutomationEventReceipt delivery={delivery} busy={false} onCancel={() => {}} />);
    expect(unknown).toContain("结果未知"); expect(unknown).toContain("不会自动重新派发"); expect(unknown).not.toContain("取消所属运行");
    const accepted = renderToStaticMarkup(<AutomationEventReceipt delivery={{ ...delivery, state: "dispatched", routineRunId: "verified-id" }} busy={false} onCancel={() => {}} />);
    expect(accepted).toContain("已交给 Routine"); expect(accepted).toContain("verified-id"); expect(accepted).toContain("取消所属运行"); expect(accepted).not.toContain("已完成");
  });
});
