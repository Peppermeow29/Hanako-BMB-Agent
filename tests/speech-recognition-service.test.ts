import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";
import { SpeechRecognitionService } from "../core/speech-recognition-service.ts";
import { ProviderRegistry } from "../core/provider-registry.ts";

function makeProviderRegistry() {
  return {
    getMediaProviders: vi.fn(() => [
      {
        providerId: "mimo",
        displayName: "MiMo",
        authType: "api-key",
        models: [
          { id: "mimo-v2.5-asr", displayName: "MiMo ASR", protocolId: "mimo-chat-completions-asr" },
        ],
      },
      {
        providerId: "ghost",
        displayName: "Ghost",
        authType: "api-key",
        models: [
          { id: "ghost-asr", displayName: "Ghost ASR", protocolId: "ghost-asr" },
        ],
      },
    ]),
    getMediaProviderCredentialStatus: vi.fn((providerId) => ({
      hasCredentials: providerId !== "ghost",
      unavailableReason: providerId === "ghost" ? "no_credentials" : null,
      lanes: [],
    })),
    resolveMediaModel: vi.fn(() => ({
      capability: "speech_recognition",
      providerId: "mimo",
      provider: { id: "mimo", displayName: "MiMo", baseUrl: "https://api.xiaomimimo.com/v1" },
      model: { id: "mimo-v2.5-asr", protocolId: "mimo-chat-completions-asr" },
      credentialLane: null,
    })),
    getCredentials: vi.fn(() => ({
      apiKey: "mimo-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
    })),
  };
}

describe("SpeechRecognitionService", () => {
  it("lists only provider models with registered speech adapters", () => {
    const service = new SpeechRecognitionService({
      providerRegistry: makeProviderRegistry(),
      preferences: { getSpeechRecognitionConfig: () => ({ enabled: false }) },
      sessionFiles: new SessionFileRegistry(),
      emitEvent: vi.fn(),
    });
    service.registerAdapter({
      id: "mimo",
      protocolId: "mimo-chat-completions-asr",
      types: ["speechRecognition"],
      transcribe: vi.fn(),
    });

    const result = service.listProviders();

    expect(Object.keys(result.providers)).toEqual(["mimo"]);
    expect(result.providers.mimo.models).toEqual([
      expect.objectContaining({
        id: "mimo-v2.5-asr",
        adapterAvailable: true,
      }),
    ]);
  });

  it("transcribes a voice-input SessionFile and persists pending then ready state", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-speech-service-"));
    try {
      const sessionPath = path.join(tmpDir, "session.jsonl");
      const voicePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(sessionPath, "{}\n");
      fs.writeFileSync(voicePath, "RIFF");
      let now = 1000;
      const sessionFiles = new SessionFileRegistry({ now: () => now });
      const file = sessionFiles.registerFile({
        sessionPath,
        filePath: voicePath,
        label: "录音 1.wav",
        origin: "voice_input",
        storageKind: "managed_cache",
        presentation: "voice-input",
        listed: false,
      });
      const emitEvent = vi.fn();
      const adapter = {
        id: "mimo",
        protocolId: "mimo-chat-completions-asr",
        types: ["speechRecognition"],
        transcribe: vi.fn(async () => ({ text: "今晚我们先把语音输入跑通。", language: "zh" })),
      };
      const service = new SpeechRecognitionService({
        providerRegistry: makeProviderRegistry(),
        preferences: {
          getSpeechRecognitionConfig: () => ({
            enabled: true,
            defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
          }),
        },
        sessionFiles,
        emitEvent,
      });
      service.registerAdapter(adapter);

      now = 2000;
      const result = await service.transcribeVoiceAttachment({ sessionPath, fileId: file.id });

      expect(result).toMatchObject({ status: "ready", text: "今晚我们先把语音输入跑通。" });
      expect(adapter.transcribe).toHaveBeenCalledWith(expect.objectContaining({
        file: expect.objectContaining({ id: file.id, filePath: voicePath }),
        model: expect.objectContaining({ id: "mimo-v2.5-asr" }),
        credentials: expect.objectContaining({ apiKey: "mimo-key" }),
      }));
      expect(sessionFiles.get(file.id, { sessionPath })?.transcription).toMatchObject({
        status: "ready",
        text: "今晚我们先把语音输入跑通。",
        providerId: "mimo",
        modelId: "mimo-v2.5-asr",
        protocolId: "mimo-chat-completions-asr",
        language: "zh",
      });
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "voice_transcription_update",
        fileId: file.id,
        transcription: expect.objectContaining({ status: "pending" }),
      }), sessionPath);
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "voice_transcription_update",
        fileId: file.id,
        transcription: expect.objectContaining({ status: "ready", text: "今晚我们先把语音输入跑通。" }),
      }), sessionPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves MiMo Token Plan STT with Token Plan credentials and base URL", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-speech-token-plan-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
        "providers:",
        "  mimo-token-plan:",
        "    api_key: tp-mimo-key",
        "    base_url: https://token-plan-cn.xiaomimimo.com/v1",
        "    api: openai-completions",
        "",
      ].join("\n"), "utf-8");
      const providerRegistry = new ProviderRegistry(tmpDir);
      providerRegistry.reload();

      const sessionPath = path.join(tmpDir, "session.jsonl");
      const voicePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(sessionPath, "{}\n");
      fs.writeFileSync(voicePath, "RIFF");
      const sessionFiles = new SessionFileRegistry();
      const file = sessionFiles.registerFile({
        sessionPath,
        filePath: voicePath,
        label: "voice.wav",
        origin: "voice_input",
        storageKind: "managed_cache",
        presentation: "voice-input",
        listed: false,
      });
      const adapter = {
        id: "mimo",
        protocolId: "mimo-chat-completions-asr",
        types: ["speechRecognition"],
        transcribe: vi.fn(async () => ({ text: "token plan ready", language: "auto" })),
      };
      const service = new SpeechRecognitionService({
        providerRegistry,
        preferences: {
          getSpeechRecognitionConfig: () => ({
            enabled: true,
            defaultModel: { provider: "mimo-token-plan", id: "mimo-v2.5-asr" },
          }),
        },
        sessionFiles,
        emitEvent: vi.fn(),
      });
      service.registerAdapter(adapter);

      const result = await service.transcribeVoiceAttachment({ sessionPath, fileId: file.id });

      expect(result).toMatchObject({
        status: "ready",
        providerId: "mimo-token-plan",
        protocolId: "mimo-chat-completions-asr",
      });
      expect(adapter.transcribe).toHaveBeenCalledWith(expect.objectContaining({
        provider: expect.objectContaining({
          id: "mimo-token-plan",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        }),
        credentials: expect.objectContaining({
          apiKey: "tp-mimo-key",
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          api: "openai-completions",
        }),
      }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("transcribes a SessionFile by sessionId when no path locator is supplied", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-speech-service-"));
    try {
      const sessionPath = path.join(tmpDir, "session.jsonl");
      const audioPath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(sessionPath, "{}\n");
      fs.writeFileSync(audioPath, "RIFF");
      const sessionFiles = new SessionFileRegistry();
      const file = sessionFiles.registerFile({
        sessionId: "sess_asr",
        sessionPath,
        filePath: audioPath,
        label: "voice.wav",
        origin: "voice_input",
        storageKind: "managed_cache",
      });
      const emitEvent = vi.fn();
      const adapter = {
        id: "mimo",
        protocolId: "mimo-chat-completions-asr",
        types: ["speechRecognition"],
        transcribe: vi.fn(async () => ({ text: "done", language: "en" })),
      };
      const service = new SpeechRecognitionService({
        providerRegistry: makeProviderRegistry(),
        preferences: {
          getSpeechRecognitionConfig: () => ({
            enabled: true,
            defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
          }),
        },
        sessionFiles,
        emitEvent,
      });
      service.registerAdapter(adapter);

      const result = await service.transcribeAudio({ sessionId: "sess_asr", fileId: file.id });

      expect(result).toMatchObject({ status: "ready", text: "done" });
      expect(sessionFiles.get(file.id, { sessionId: "sess_asr" })?.transcription).toMatchObject({
        status: "ready",
        text: "done",
      });
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "voice_transcription_update",
        sessionId: "sess_asr",
        fileId: file.id,
      }), null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects transcribeAudio when fileId belongs to another loaded session", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-speech-cross-session-"));
    try {
      const ownerSessionPath = path.join(tmpDir, "owner.jsonl");
      const otherSessionPath = path.join(tmpDir, "other.jsonl");
      const voicePath = path.join(tmpDir, "voice.wav");
      fs.writeFileSync(ownerSessionPath, "{}\n");
      fs.writeFileSync(otherSessionPath, "{}\n");
      fs.writeFileSync(voicePath, "RIFF");
      const sessionFiles = new SessionFileRegistry();
      const file = sessionFiles.registerFile({
        sessionPath: ownerSessionPath,
        filePath: voicePath,
        label: "voice.wav",
        origin: "voice_input",
        storageKind: "managed_cache",
        presentation: "voice-input",
        listed: false,
      });
      const adapter = {
        id: "mimo",
        protocolId: "mimo-chat-completions-asr",
        types: ["speechRecognition"],
        transcribe: vi.fn(async () => ({ text: "should not run" })),
      };
      const service = new SpeechRecognitionService({
        providerRegistry: makeProviderRegistry(),
        preferences: {
          getSpeechRecognitionConfig: () => ({
            enabled: true,
            defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
          }),
        },
        sessionFiles,
        emitEvent: vi.fn(),
      });
      service.registerAdapter(adapter);

      await expect(service.transcribeAudio({
        sessionPath: otherSessionPath,
        fileId: file.id,
      })).rejects.toThrow(/session file not found/);
      expect(adapter.transcribe).not.toHaveBeenCalled();
      expect(sessionFiles.get(file.id, { sessionPath: ownerSessionPath })?.transcription)
        .toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("logs queued transcription failures instead of swallowing them silently", async () => {
    const warn = vi.fn();
    const service = new SpeechRecognitionService({
      providerRegistry: makeProviderRegistry(),
      preferences: {
        getSpeechRecognitionConfig: () => ({
          enabled: true,
          defaultModel: { provider: "mimo", id: "mimo-v2.5-asr" },
        }),
      },
      sessionFiles: new SessionFileRegistry(),
      emitEvent: vi.fn(),
      logger: { warn },
    });
    service.registerAdapter({
      id: "mimo",
      protocolId: "mimo-chat-completions-asr",
      types: ["speechRecognition"],
      transcribe: vi.fn(),
    });

    await service.queueVoiceTranscription({ sessionPath: "/tmp/missing.jsonl", fileId: "sf_missing" });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sf_missing"));
  });
});
