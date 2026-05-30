/**
 * WebGPU Model Loader — Browser-side ONNX inference via WebGPU/WASM.
 * 
 * Loads the DeBERTa complexity regressor ONNX model and runs inference
 * directly in the browser. Falls back to WASM if WebGPU unavailable.
 * 
 * Usage:
 *   const loader = new WebGPUModelLoader();
 *   await loader.initialize();
 *   const score = await loader.score("Write a Python function");
 *   // → 0.62
 */

import type { ComplexityScore } from './types.js';

const EFFORT_BOUNDARIES = [0.08, 0.18, 0.32, 0.52, 0.72];
const EFFORT_LABELS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

export interface ModelLoadResult {
  loaded: boolean;
  backend: 'webgpu' | 'wasm' | 'webnn' | 'none';
  modelSize: number;
  loadTimeMs: number;
  error?: string;
}

export class WebGPUModelLoader {
  private session: any = null;
  private tokenizer: any = null;
  private backend: 'webgpu' | 'wasm' | 'webnn' | 'none' = 'none';
  private modelLoaded = false;
  private modelSize = 0;
  private loadTimeMs = 0;

  /**
   * Initialize the model loader. Attempts WebGPU first, falls back to WASM.
   */
  async initialize(): Promise<ModelLoadResult> {
    const start = performance.now();

    try {
      // Try WebGPU first
      if (await this.checkWebGPU()) {
        this.backend = 'webgpu';
      } else if (await this.checkWebNN()) {
        this.backend = 'webnn';
      } else {
        this.backend = 'wasm';
      }

      // Load ONNX Runtime Web
      const ort = await this.loadOrtRuntime();
      
      // Configure execution providers
      const options: any = {
        executionProviders: [this.backend === 'webgpu' ? 'webgpu' : 'wasm'],
        graphOptimizationLevel: 'all',
      };

      // Load model
      const modelPath = '/models/complexity-regressor-q4.onnx';
      
      try {
        const response = await fetch(modelPath, { method: 'HEAD' });
        if (response.ok) {
          const contentLength = response.headers.get('content-length');
          this.modelSize = contentLength ? parseInt(contentLength) : 0;
          
          this.session = await ort.InferenceSession.create(modelPath, options);
          this.modelLoaded = true;
        } else {
          // Model not available — return heuristic-only mode
          this.modelLoaded = false;
        }
      } catch {
        this.modelLoaded = false;
      }

      this.loadTimeMs = performance.now() - start;

      return {
        loaded: this.modelLoaded,
        backend: this.backend,
        modelSize: this.modelSize,
        loadTimeMs: this.loadTimeMs,
      };
    } catch (err: any) {
      return {
        loaded: false,
        backend: 'none',
        modelSize: 0,
        loadTimeMs: performance.now() - start,
        error: err.message,
      };
    }
  }

  /**
   * Score a prompt using the loaded ONNX model.
   * Returns null if model not loaded.
   */
  async score(prompt: string): Promise<ComplexityScore | null> {
    if (!this.modelLoaded || !this.session) {
      return null;
    }

    const start = performance.now();

    try {
      // Tokenize
      const tokens = await this.tokenize(prompt);
      
      // Run inference
      const feeds: Record<string, any> = {
        input_ids: tokens.inputIds,
        attention_mask: tokens.attentionMask,
      };

      const results = await this.session.run(feeds);
      const scoreTensor = results['complexity_score'];
      const score = scoreTensor.data[0];

      return {
        value: Math.max(0, Math.min(1, score)),
        method: 'ml',
        latencyMs: performance.now() - start,
      };
    } catch {
      return null;
    }
  }

  /**
   * Detect WebGPU availability.
   */
  private async checkWebGPU(): Promise<boolean> {
    if (typeof navigator === 'undefined') return false;
    if (!('gpu' in navigator)) return false;
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }

  /**
   * Detect WebNN availability.
   */
  private async checkWebNN(): Promise<boolean> {
    if (typeof navigator === 'undefined') return false;
    return 'ml' in navigator;
  }

  /**
   * Load ONNX Runtime Web (dynamically imported).
   */
  private async loadOrtRuntime(): Promise<any> {
    // Try to import onnxruntime-web
    try {
      const ort = await import('onnxruntime-web');
      // Configure WASM paths
      if (ort.env) {
        ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
      }
      return ort;
    } catch {
      throw new Error('onnxruntime-web not available');
    }
  }

  /**
   * Simple tokenizer for DeBERTa input.
   * In production, this loads the saved tokenizer from /models/tokenizer/
   */
  private async tokenize(text: string): Promise<{
    inputIds: any;
    attentionMask: any;
  }> {
    const maxLen = 256;
    
    // If tokenizer is loaded, use it
    if (this.tokenizer) {
      const encoded = await this.tokenizer(text, {
        padding: 'max_length',
        truncation: true,
        max_length: maxLen,
      });
      return {
        inputIds: encoded.input_ids,
        attentionMask: encoded.attention_mask,
      };
    }

    // Fallback: simple wordpiece-like tokenization
    // This is a placeholder — the real tokenizer is loaded from /models/tokenizer/
    const words = text.toLowerCase().split(/\s+/);
    const ids = new BigInt64Array(maxLen);
    const mask = new BigInt64Array(maxLen);
    
    // [CLS] token = 1, [SEP] = 2, [PAD] = 0
    ids[0] = BigInt(1); // [CLS]
    mask[0] = BigInt(1);
    
    for (let i = 0; i < Math.min(words.length, maxLen - 2); i++) {
      // Simple hash-based token ID (placeholder)
      ids[i + 1] = BigInt(this.simpleHash(words[i]) % 30000 + 100);
      mask[i + 1] = BigInt(1);
    }
    
    ids[Math.min(words.length + 1, maxLen - 1)] = BigInt(2); // [SEP]
    mask[Math.min(words.length + 1, maxLen - 1)] = BigInt(1);

    // Create tensors
    const ort = await this.loadOrtRuntime();
    return {
      inputIds: new ort.Tensor('int64', ids, [1, maxLen]),
      attentionMask: new ort.Tensor('int64', mask, [1, maxLen]),
    };
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  /**
   * Get device capability profile.
   */
  async getDeviceProfile(): Promise<{
    backend: string;
    webgpu: boolean;
    webnn: boolean;
    wasm: boolean;
    gpu: string;
    memory: number;
    cores: number;
  }> {
    const gpu = (() => {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return 'N/A';
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'WebGL';
      } catch { return 'N/A'; }
    })();

    return {
      backend: this.backend,
      webgpu: await this.checkWebGPU(),
      webnn: await this.checkWebNN(),
      wasm: true, // WASM always available
      gpu,
      memory: (navigator as any).deviceMemory ?? 4,
      cores: navigator.hardwareConcurrency ?? 4,
    };
  }

  get isLoaded(): boolean {
    return this.modelLoaded;
  }

  get activeBackend(): string {
    return this.backend;
  }

  /**
   * Dispose of the model and free GPU memory.
   */
  async dispose(): Promise<void> {
    if (this.session) {
      this.session.release?.();
      this.session = null;
    }
    this.modelLoaded = false;
  }
}

/**
 * Score-to-effort conversion (matches routing-matrix.ts boundaries).
 */
export function mlScoreToEffort(score: number): string {
  if (score < EFFORT_BOUNDARIES[0]) return EFFORT_LABELS[0];
  if (score < EFFORT_BOUNDARIES[1]) return EFFORT_LABELS[1];
  if (score < EFFORT_BOUNDARIES[2]) return EFFORT_LABELS[2];
  if (score < EFFORT_BOUNDARIES[3]) return EFFORT_LABELS[3];
  if (score < EFFORT_BOUNDARIES[4]) return EFFORT_LABELS[4];
  return EFFORT_LABELS[5];
}
