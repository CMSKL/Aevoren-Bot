import { createHash } from "node:crypto";
import { BROWSER_OPERATION_SCHEMAS, BROWSER_PRODUCT_OPERATIONS } from "@shared/browser-product";
import type * as B from "@shared/browser-contracts";
import type { AppRepository } from "./database";
import type { BrowserService, BrowserCallContext } from "./browser-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";

export type BrowserProductDependencies = {
  repository: AppRepository;
  browserService?: BrowserService;
  saveBrowserDownload?(input: B.BrowserDownloadInput, context: BrowserCallContext): Promise<B.BrowserDownloadResult | null>;
};

export function addBrowserProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: BrowserProductDependencies,
  commit: <T>(operation: () => T) => T = operation => operation(), context?: LibraryExecutionContext): void {
  const service = (): BrowserService => {
    if (!dependencies.browserService) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    return dependencies.browserService;
  };
  for (const definition of BROWSER_PRODUCT_OPERATIONS) handlers.set(definition.channel, async input => {
    context?.signal?.throwIfAborted();
    let scoped = input;
    if (context) {
      const supplied = (input ?? {}) as Record<string, unknown>;
      if (supplied.sessionId !== undefined && supplied.sessionId !== context.sessionId || supplied.executorBotId !== undefined && supplied.executorBotId !== context.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      dependencies.repository.assertSessionExecutor(context.sessionId, context.executorBotId);
      scoped = { ...supplied, sessionId: context.sessionId, executorBotId: context.executorBotId };
    }
    const parsed = (context ? BROWSER_OPERATION_SCHEMAS[definition.name]!.parse(scoped) : scoped) as B.BrowserScope & Record<string, unknown>;
    if (context && ["computer.takeover", "computer.returnControl", "computer.vncTicket"].includes(definition.name)) {
      return { status: "waiting_user", reason: "请用户在当前会话的电脑面板明确接管或归还控制权；连接权限只提供给可信本机界面。" };
    }
    const callContext: BrowserCallContext = { actor: context ? "ai" : "user", signal: context?.signal, runtimeRunId: context?.runtimeRunId };
    if (context && definition.effectClass === "irreversible") {
      const rootNonce = dependencies.repository.getRuntimeRun(context.runtimeRunId).clientNonce;
      const hash = createHash("sha256").update(`${rootNonce}:${context.sessionId}:${context.executorBotId}:${definition.name}:${JSON.stringify(parsed)}`).digest("hex");
      callContext.operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      parsed.clientNonce = callContext.operationId;
    }
    let result: unknown;
    switch (definition.name) {
      case "browser.get": return service().get(parsed);
      case "browser.start": result = await service().start(parsed as B.BrowserMutationInput, callContext); break;
      case "browser.stop": result = await service().stop(parsed as B.BrowserMutationInput, callContext); break;
      case "browser.tabs": return service().tabs(parsed as B.BrowserEpochInput, callContext);
      case "browser.newTab": result = await service().newTab(parsed as B.BrowserNewTabInput, callContext); break;
      case "browser.closeTab": result = await service().closeTab(parsed as B.BrowserPageMutationInput, callContext); break;
      case "browser.navigate": result = await service().navigate(parsed as B.BrowserNavigateInput, callContext); break;
      case "browser.read": return service().read(parsed as B.BrowserReadInput, callContext);
      case "browser.observe": return service().observe(parsed as B.BrowserObserveInput, callContext);
      case "browser.click": result = await service().click(parsed as B.BrowserClickInput, callContext); break;
      case "browser.type": result = await service().type(parsed as B.BrowserTypeInput, callContext); break;
      case "browser.key": result = await service().key(parsed as B.BrowserKeyInput, callContext); break;
      case "browser.scroll": result = await service().scroll(parsed as B.BrowserScrollInput, callContext); break;
      case "browser.downloads": return service().downloads(parsed as B.BrowserEpochInput, callContext);
      case "browser.download": result = await dependencies.saveBrowserDownload?.(parsed as B.BrowserDownloadInput, callContext) ?? null; break;
      case "computer.view": return service().view(parsed);
      case "computer.screenshot": return service().computerScreenshot(parsed as B.ComputerScreenshotInput, callContext);
      case "computer.click": result = await service().computerClick(parsed as B.ComputerClickInput, callContext); break;
      case "computer.type": result = await service().computerType(parsed as B.ComputerTypeInput, callContext); break;
      case "computer.key": result = await service().computerKey(parsed as B.ComputerKeyInput, callContext); break;
      case "computer.scroll": result = await service().computerScroll(parsed as B.ComputerScrollInput, callContext); break;
      case "computer.takeover": result = await service().takeover(parsed as B.ComputerControlInput, callContext); break;
      case "computer.returnControl": result = await service().returnControl(parsed as B.ComputerControlInput, callContext); break;
      case "computer.vncTicket": result = await service().vncTicket(parsed as B.BrowserEpochInput & { clientNonce: string }, callContext); break;
      case "preview.list": return service().previewList(parsed as B.BrowserEpochInput, callContext);
      case "preview.open": result = await service().previewOpen(parsed as B.PreviewOpenInput, callContext); break;
      case "preview.close": result = await service().previewClose(parsed as B.PreviewCloseInput, callContext); break;
      default: throw new AevorenBotError("INVALID_REQUEST");
    }
    context?.signal?.throwIfAborted();
    return commit(() => { context?.signal?.throwIfAborted(); return result; });
  });
}
