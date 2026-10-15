import { expect, it } from "vitest";
import { REALTIME_OPERATION_SCHEMAS, REALTIME_PRODUCT_OPERATIONS } from "./realtime-product";
import { REALTIME_CHANNELS } from "./realtime-channels";
it("exposes scoped status and stop controls without microphone or audio lifecycle authority",()=>{
  expect(REALTIME_PRODUCT_OPERATIONS.map(item=>item.name)).toEqual(["voice.realtime.snapshot","voice.realtime.stop","voice.realtime.stopTask"]);
  for(const definition of REALTIME_PRODUCT_OPERATIONS){
    expect(Object.values(REALTIME_CHANNELS)).not.toContain(definition.channel);
    const schema=REALTIME_OPERATION_SCHEMAS[definition.name]!;
    const base={id:"10000000-0000-4000-8000-000000000001"};
    expect(schema.safeParse(base).success).toBe(true);
    for(const extra of [{captureId:base.id},{dataBase64:"AAAA"},{executorBotId:base.id},{apiKey:"secret"},{playedSamples:0}])
      expect(schema.safeParse({...base,...extra}).success).toBe(false);
  }
});
