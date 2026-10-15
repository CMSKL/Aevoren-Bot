import { NATIVE_OUTBOUND_PRODUCT_OPERATIONS, NATIVE_OUTBOUND_OPERATION_SCHEMAS } from "@shared/native-outbound-product";
import type { NativeOutboundIdInput, NativeOutboundPrepareInput, NativeWriteGrantInput, NativeWriteRevokeInput } from "@shared/native-outbound-contracts";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ConnectorIdInput } from "@shared/native-connector-contracts";
import type { AppRepository } from "./database";
import type { NativeOutboundService } from "./native-outbound-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";
export function addNativeOutboundProductHandlers(handlers:Map<string,(input?:unknown)=>unknown>,dependencies:{repository:AppRepository;nativeOutboundService?:NativeOutboundService},context?:LibraryExecutionContext):void{
  for(const definition of NATIVE_OUTBOUND_PRODUCT_OPERATIONS)handlers.set(definition.channel,async input=>{
    const service=dependencies.nativeOutboundService;if(!service)throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
    const assertCurrent=()=>{context?.signal?.throwIfAborted();if(context)dependencies.repository.connectors.assertRuntimeCurrent(context.runtimeRunId,{sessionId:context.sessionId,executorBotId:context.executorBotId});};assertCurrent();
    const supplied=(input??{}) as Record<string,unknown>;if(context&&(supplied.sessionId!==undefined&&supplied.sessionId!==context.sessionId||supplied.executorBotId!==undefined&&supplied.executorBotId!==context.executorBotId))throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");
    const parsed=NATIVE_OUTBOUND_OPERATION_SCHEMAS[definition.name]!.parse(context&&definition.name!=="outbound.enableSend"?{...supplied,sessionId:context.sessionId,executorBotId:context.executorBotId}:input);
    const execution={signal:context?.signal,assertCurrent};
    switch(definition.name){
      case"outbound.writeGrants":return service.writeGrants(parsed as EnvironmentScope);
      case"outbound.grantWrite":return service.grantWrite(parsed as NativeWriteGrantInput);
      case"outbound.revokeWrite":return service.revokeWrite(parsed as NativeWriteRevokeInput);
      case"outbound.enableSend":return service.enableSend(parsed as ConnectorIdInput,execution);
      case"outbound.prepare":return service.prepare(parsed as NativeOutboundPrepareInput,execution);
      case"outbound.get":return service.get(parsed as NativeOutboundIdInput);
      case"outbound.list":return service.list(parsed as EnvironmentScope);
      case"outbound.reconcile":return service.reconcile(parsed as NativeOutboundIdInput,execution);
      case"outbound.cancel":return service.cancel(parsed as NativeOutboundIdInput);
      case"outbound.reject":return service.reject(parsed as NativeOutboundIdInput);
      case"outbound.send":throw new AevorenBotError("APPROVAL_REVIEW_INVALID");
    }
  });
}
