/**
 * Platform Detection — WebGPU / WebNN / WASM backend cascade
 */

import type { BackendInfo, BackendType, DeviceProfile } from './types.js';

const DEVICE_PROFILES: Record<string, Omit<DeviceProfile, 'cores'>> = {
  'desktop-webgpu': {
    backend: 'webgpu',
    memoryGB: 8,
    isMobile: false,
    tier1Limit: 0.3,
    tier2Limit: 0.6,
    recommendedModels: {
      worker: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
      gatekeeper: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    },
  },
  'mobile-webgpu': {
    backend: 'webgpu',
    memoryGB: 4,
    isMobile: true,
    tier1Limit: 0.25,
    tier2Limit: 0.5,
    recommendedModels: {
      worker: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
      gatekeeper: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    },
  },
  'mobile-wasm': {
    backend: 'wasm',
    memoryGB: 2,
    isMobile: true,
    tier1Limit: 0.15,
    tier2Limit: 0.35,
    recommendedModels: {
      worker: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
      gatekeeper: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    },
  },
  lowend: {
    backend: 'wasm',
    memoryGB: 1,
    isMobile: true,
    tier1Limit: 0.1,
    tier2Limit: 0.2,
    recommendedModels: {
      worker: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
      gatekeeper: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    },
  },
};

export async function detectBackend(): Promise<BackendInfo> {
  let webgpu = false;
  let webnn = false;

  // Check WebGPU
  if (typeof navigator !== 'undefined' && (navigator as any).gpu) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      webgpu = adapter !== null;
    } catch {
      webgpu = false;
    }
  }

  // Check WebNN
  if (typeof navigator !== 'undefined' && 'ml' in navigator) {
    webnn = true;
  }

  // Detect memory
  const deviceMemory =
    typeof navigator !== 'undefined'
      ? (navigator as any).deviceMemory ?? null
      : null;

  // Detect mobile
  const isMobile =
    typeof navigator !== 'undefined'
      ? /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
      : false;

  // Determine best backend
  let type: BackendType = 'wasm';
  if (webgpu) type = 'webgpu';
  else if (webnn) type = 'webnn';

  return { type, webgpu, webnn, wasm: true, deviceMemory, isMobile };
}

export function getDeviceProfile(info: BackendInfo): DeviceProfile {
  const memory = info.deviceMemory ?? 1;

  let profileKey: string;
  if (info.webgpu && !info.isMobile && memory >= 8) {
    profileKey = 'desktop-webgpu';
  } else if (info.webgpu && info.isMobile && memory >= 4) {
    profileKey = 'mobile-webgpu';
  } else if (info.isMobile && memory >= 2) {
    profileKey = 'mobile-wasm';
  } else {
    profileKey = 'lowend';
  }

  const base = DEVICE_PROFILES[profileKey];
  return {
    ...base,
    cores: typeof navigator !== 'undefined' ? (navigator as any).hardwareConcurrency ?? 4 : 4,
  };
}
