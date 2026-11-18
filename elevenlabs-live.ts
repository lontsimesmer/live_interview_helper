/**
 * ElevenLabs Agents as Sarah's live voice.
 *
 * The rest of the live call (timers, tools, transcript, grading) was written for Gemini Live, so
 * this adapter exposes the same small session interface and translates ElevenLabs' WebSocket
 * events into Gemini-shaped messages:
 *
 *   session.sendRealtimeInput({ audio })      -> { user_audio_chunk }
 *   session.sendClientContent({ turns, turnComplete: true })  -> user_message   (Sarah replies)
 *   session.sendClientContent({ turns, turnComplete: false }) -> contextual_update (silent context)
 *   session.sendToolResponse({ functionResponses })            -> client_tool_result
 *
 *   audio                 -> serverContent.modelTurn.parts[].inlineData (PCM 24 kHz, like Gemini)
 *   agent_response        -> serverContent.outputTranscription (audio tags such as [laughs] removed)
 *   user_transcript       -> serverContent.inputTranscription
 *   interruption          -> serverContent.interrupted
 *   end of Sarah's audio  -> serverContent.turnComplete
 *   client_tool_call      -> toolCall.functionCalls
 *
 * Configuration (.env): ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID. The agent (voice, expressive
 * model, patient turn-taking, client tools, allowed overrides) is created by
 * `npm run elevenlabs:setup`, see scripts/elevenlabs-setup.ts.
 */
import WebSocket from 'ws';

const API_BASE = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');

export function isElevenLabsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_AGENT_ID?.trim());
}

/**
 * Sarah is always a female voice. Default: ElevenLabs' premade female voice "Sarah" (warm,
 * professional, American English). ELEVENLABS_VOICE_ID may name another FEMALE voice.
 */
export const DEFAULT_FEMALE_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
function voiceOverride(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_FEMALE_VOICE_ID;
}

/** Removes audio tags ("[laughs]", "[warmly]") from captions and the written transcript. */
export function stripAudioTags(text: string): string {
  return String(text || '')
    .replace(/\[[a-z][a-z \-']{0,30}\]/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Linear resampling of 16-bit mono PCM (ElevenLabs may be set to a rate other than 24 kHz). */
function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const inSamples = Math.floor(input.length / 2);
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * fromRate) / toRate;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = pos - i0;
    const s = input.readInt16LE(i0 * 2) * (1 - frac) + input.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

async function getSignedUrl(apiKey: string, agentId: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(8000) }
  );
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.signed_url) {
    throw new Error(`ElevenLabs signed URL failed (${res.status}): ${JSON.stringify(data?.detail || data).slice(0, 200)}`);
  }
  return data.signed_url;
}

export interface LiveCallbacks {
  onopen?: () => void;
  onmessage: (message: any) => void;
  onerror?: (err: any) => void;
  onclose?: (event: { code?: number; reason?: string }) => void;
}

export interface LiveSessionLike {
  readonly provider: 'elevenlabs';
  sendRealtimeInput(input: { audio: { data: string; mimeType?: string } }): Promise<void>;
  sendClientContent(content: { turns: { role?: string; parts: { text?: string }[] }[]; turnComplete?: boolean }): Promise<void>;
  sendToolResponse(response: { functionResponses: { id: string; name?: string; response?: any }[] }): Promise<void>;
  close(): void;
}

/**
 * Opens an ElevenLabs agent conversation with the interview prompt. Resolves once ElevenLabs has
 * accepted the conversation (conversation_initiation_metadata), rejects on failure.
 */
export async function connectElevenLabsLive(params: {
  systemInstruction: string;
  vocabulary?: string[];
  callbacks: LiveCallbacks;
  connectTimeoutMs?: number;
}): Promise<LiveSessionLike> {
  const apiKey = process.env.ELEVENLABS_API_KEY!.trim();
  const agentId = process.env.ELEVENLABS_AGENT_ID!.trim();
  const signedUrl = await getSignedUrl(apiKey, agentId);
  const ws = new WebSocket(signedUrl);
  const { callbacks } = params;

  let outputRate = 24000;
  let ready = false;
  let closed = false;
  // Sarah's turn ends when her audio stops arriving (ElevenLabs has no explicit "turn complete"
  // for audio), or shortly after agent_response_complete.
  let turnOpen = false;
  let turnTimer: NodeJS.Timeout | null = null;
  const endTurnSoon = (ms: number) => {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      turnTimer = null;
      if (!turnOpen || closed) return;
      turnOpen = false;
      callbacks.onmessage({ serverContent: { turnComplete: true } });
    }, ms);
  };

  const send = (payload: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const session: LiveSessionLike = {
    provider: 'elevenlabs',
    async sendRealtimeInput(input) {
      if (input?.audio?.data) send({ user_audio_chunk: input.audio.data });
    },
    async sendClientContent(content) {
      const text = (content?.turns || [])
        .flatMap((t) => t.parts || [])
        .map((p) => p.text || '')
        .join('\n')
        .trim();
      if (!text) return;
      if (content.turnComplete) send({ type: 'user_message', text });
      else send({ type: 'contextual_update', text });
    },
    async sendToolResponse(response) {
      for (const r of response?.functionResponses || []) {
        const result = r?.response?.result ?? r?.response ?? '';
        send({
          type: 'client_tool_result',
          tool_call_id: r.id,
          result: typeof result === 'string' ? result : JSON.stringify(result),
          is_error: false,
        });
      }
    },
    close() {
      closed = true;
      if (turnTimer) clearTimeout(turnTimer);
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };

  return await new Promise<LiveSessionLike>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (ready) return;
      session.close();
      reject(new Error('ElevenLabs conversation did not start in time'));
    }, params.connectTimeoutMs ?? 10000);

    ws.on('open', () => {
      const override: any = { agent: { prompt: { prompt: params.systemInstruction }, first_message: '', language: 'en' } };
      // Sent on every call, so the voice stays female even if the agent's default is changed.
      override.tts = { voice_id: voiceOverride() };
      if (params.vocabulary?.length) override.asr = { keywords: params.vocabulary.slice(0, 40) };
      send({ type: 'conversation_initiation_client_data', conversation_config_override: override });
    });

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg?.type) {
        case 'conversation_initiation_metadata': {
          const fmt = String(msg.conversation_initiation_metadata_event?.agent_output_audio_format || 'pcm_24000');
          const rate = Number(fmt.match(/^pcm_(\d+)$/)?.[1]);
          if (rate) outputRate = rate;
          else console.warn(`[ElevenLabs] Unsupported output format ${fmt}; set the agent to pcm_24000.`);
          ready = true;
          clearTimeout(timeout);
          callbacks.onopen?.();
          resolve(session);
          break;
        }
        case 'ping':
          send({ type: 'pong', event_id: msg.ping_event?.event_id });
          break;
        case 'audio': {
          const b64 = msg.audio_event?.audio_base_64;
          if (!b64) break;
          const pcm = resamplePcm16(Buffer.from(b64, 'base64'), outputRate, 24000);
          turnOpen = true;
          callbacks.onmessage({
            serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] } },
          });
          endTurnSoon(1500);
          break;
        }
        case 'agent_response': {
          const text = stripAudioTags(msg.agent_response_event?.agent_response || '');
          turnOpen = true;
          if (text) callbacks.onmessage({ serverContent: { outputTranscription: { text: `${text} ` } } });
          endTurnSoon(2500); // audio normally follows; this only closes a turn that has none
          break;
        }
        case 'agent_response_complete':
          endTurnSoon(600);
          break;
        case 'user_transcript': {
          const text = msg.user_transcription_event?.user_transcript;
          if (text) callbacks.onmessage({ serverContent: { inputTranscription: { text: `${text} ` } } });
          break;
        }
        case 'interruption':
          turnOpen = false;
          if (turnTimer) clearTimeout(turnTimer);
          callbacks.onmessage({ serverContent: { interrupted: true } });
          break;
        case 'client_tool_call': {
          const c = msg.client_tool_call || {};
          callbacks.onmessage({
            toolCall: { functionCalls: [{ id: c.tool_call_id, name: c.tool_name, args: c.parameters || {} }] },
          });
          break;
        }
        case 'client_error':
          console.warn('[ElevenLabs] error:', msg.error_event?.error_name, msg.error_event?.message || '');
          break;
        default:
          break; // vad_score, metadata, corrections... not needed
      }
    });

    ws.on('error', (err: any) => {
      // Never log the signed URL: it is a credential for this conversation.
      const message = err?.code || err?.message || 'unknown error';
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`ElevenLabs connection failed: ${message}`));
        return;
      }
      callbacks.onerror?.({ message });
    });

    ws.on('close', (code, reasonBuf) => {
      closed = true;
      if (turnTimer) clearTimeout(turnTimer);
      const reason = reasonBuf?.toString() || '';
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`ElevenLabs closed before the conversation started (${code}${reason ? `: ${reason}` : ''})`));
        return;
      }
      callbacks.onclose?.({ code, reason });
    });
  });
}
