import { listRunpodEndpoints } from "./lib/runpod.mjs";

const endpoints = await listRunpodEndpoints();

console.log(
  JSON.stringify(
    endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      computeType: endpoint.computeType,
      gpuTypeIds: endpoint.gpuTypeIds,
      workersMin: endpoint.workersMin,
      workersMax: endpoint.workersMax,
      templateImage: endpoint.template?.image ?? null
    })),
    null,
    2
  )
);
