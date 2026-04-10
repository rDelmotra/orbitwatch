import {
  predictVisualPass,
  type PassPredictionWorkerRequest,
  type PassPredictionWorkerResponse,
} from '../orbital/passPrediction';

self.onmessage = (event: MessageEvent<PassPredictionWorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== 'PREDICT') {
    return;
  }

  try {
    const result = predictVisualPass({
      line1: msg.line1,
      line2: msg.line2,
      observer: msg.observer,
      nowMs: msg.nowMs,
      isCurated: msg.isCurated,
      mode: 'visual',
    });

    const response: PassPredictionWorkerResponse = {
      type: 'RESULT',
      requestId: msg.requestId,
      noradId: msg.noradId,
      result,
    };

    if (result.kind === 'ready') {
      (self as unknown as Worker).postMessage(response, [result.prediction.trailPositionsTeme.buffer]);
      return;
    }

    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: PassPredictionWorkerResponse = {
      type: 'ERROR',
      requestId: msg.requestId,
      noradId: msg.noradId,
      message: err instanceof Error ? err.message : 'Pass prediction failed.',
    };
    (self as unknown as Worker).postMessage(response);
  }
};
