import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

function render(open = true): string {
  return renderToStaticMarkup(<SettingsDialog
    open={open}
    theme="dark"
    launchAtLogin={false}
    launchAtLoginSupported={true}
    launchAtLoginStatus="not-registered"
    autoApprovePublicReadTools={true}
    updateCheckIntervalMinutes={360}
    updateState={null}
    restartBlocked={false}
    activeBotId={null}
    onClose={() => undefined}
    onThemeChange={async () => null}
    onLaunchAtLoginChange={async () => null}
    onAutoApprovePublicReadToolsChange={async () => null}
    onUpdateCheckIntervalChange={async () => null}
    onCheckUpdate={() => undefined}
    onRetryUpdate={() => undefined}
    onInstallUpdate={() => undefined}
  />);
}

describe("SettingsDialog", () => {
  it("opens a modal settings workspace over the current conversation", () => {
    const html = render();
    expect(html).toContain("settings-page");
    expect(html).toContain('role="dialog"');
    expect(html).toContain("modal-backdrop");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="关闭设置"');
  });

  it("keeps the seven global sections and directs per-Bot configuration to contacts", () => {
    const html = render();
    for (const label of ["通用", "能力与权限", "长期记忆", "应用连接", "MCP", "主动服务", "版本更新"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="模型与 CLI"');
    expect(html).toContain("Bot 的资料、模型、工具与记忆范围，请在联系人中配置。");
  });

  it("preserves the system, light and dark themes and automation preferences", () => {
    const html = render();
    expect(html).toContain("深色");
    expect(html).toContain("浅色");
    expect(html).toContain("跟随系统");
    expect(html).toContain('aria-label="自动批准公开只读工具"');
    expect(html).toContain('aria-label="登录时启动"');
    expect(html).toContain('value="dark" selected=""');
  });

  it("does not render when its page is closed", () => {
    expect(render(false)).toBe("");
  });
});
