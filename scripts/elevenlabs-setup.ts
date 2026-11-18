/**
 * Creates (or updates) Sarah's ElevenLabs agent: female expressive voice, patient turn-taking,
 * her six client tools, and the overrides the server needs (per-call prompt, voice, keywords).
 *
 *   1. Put ELEVENLABS_API_KEY in .env
 *   2. npm run elevenlabs:setup
 *   3. Copy the printed ELEVENLABS_AGENT_ID line into .env (and into Vercel's env vars)
 *
 * Run it again after changing the tools or settings: with ELEVENLABS_AGENT_ID set it updates
 * the same agent instead of creating a new one.
 *
 * Optional .env: ELEVENLABS_VOICE_ID (a FEMALE voice; default "Sarah"), ELEVENLABS_LLM
 * (the model that thinks for Sarah; default gpt-4.1).
 */
import net from 'net';
import dotenv from 'dotenv';
import { INTERVIEWER_TOOLS } from '../interviewer-agent.js';
import { DEFAULT_FEMALE_VOICE_ID } from '../elevenlabs-live.js';

net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
dotenv.config();

const API = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const KEY = process.env.ELEVENLABS_API_KEY?.trim();
if (!KEY) {
  console.error('ELEVENLABS_API_KEY is missing in .env');
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': KEY!, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data;
}

/** Gemini function declaration -> ElevenLabs client tool. */
function toClientTool(decl: any) {
  const props = decl.parameters?.properties || {};
  const properties: Record<string, { type: string; description: string }> = {};
  for (const [name, p] of Object.entries<any>(props)) {
    properties[name] = { type: String(p.type || 'STRING').toLowerCase(), description: p.description || name };
  }
  return {
    type: 'client',
    name: decl.name,
    description: decl.description,
    parameters: { type: 'object', required: decl.parameters?.required || [], properties },
    expects_response: true,
    // look_up_fact may take a few seconds; the others answer immediately.
    response_timeout_secs: decl.name === 'look_up_fact' ? 15 : 10,
  };
}

async function upsertTools(): Promise<string[]> {
  const existing: any[] = (await call('GET', '/v1/convai/tools').catch(() => ({ tools: [] })))?.tools || [];
  const ids: string[] = [];
  for (const decl of INTERVIEWER_TOOLS) {
    const tool_config = toClientTool(decl);
    const found = existing.find((t) => (t.tool_config?.name || t.name) === decl.name);
    if (found?.id) {
      await call('PATCH', `/v1/convai/tools/${found.id}`, { tool_config });
      ids.push(found.id);
      console.log(`  updated tool ${decl.name}`);
    } else {
      const created = await call('POST', '/v1/convai/tools', { tool_config });
      ids.push(created.id);
      console.log(`  created tool ${decl.name}`);
    }
  }
  return ids;
}

async function main() {
  console.log('ElevenLabs: setting up Sarah\'s tools...');
  const toolIds = await upsertTools();

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_FEMALE_VOICE_ID;
  const agentConfig = {
    name: 'Global Hire 360 - Sarah (live interviewer)',
    tags: ['global-hire-360'],
    conversation_config: {
      asr: { quality: 'high', user_input_audio_format: 'pcm_16000' },
      turn: {
        // Patient: Sarah waits for the candidate to really finish instead of jumping in.
        turn_eagerness: 'patient',
        // The platform runs its own silence check; ElevenLabs must not prompt or hang up.
        turn_timeout: 30,
        silence_end_call_timeout: -1,
      },
      tts: {
        // Eleven v4 Turbo = expressive mode: performs [laughs], [warmly]... and natural turn-taking.
        model_id: 'eleven_v4_turbo',
        voice_id: voiceId,
        agent_output_audio_format: 'pcm_24000',
      },
      conversation: { max_duration_seconds: 720 },
      agent: {
        first_message: '',
        language: 'en',
        prompt: {
          // Replaced on every call by the full interview prompt (interviewer-agent.ts).
          prompt: 'You are the Operations and Talent Manager at Global Hire 360, a warm and professional female interviewer.',
          llm: process.env.ELEVENLABS_LLM?.trim() || 'gpt-4.1',
          temperature: 0.7,
          tool_ids: toolIds,
        },
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true } },
          tts: { voice_id: true },
          asr: { keywords: true },
        },
      },
    },
  };

  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (agentId) {
    await call('PATCH', `/v1/convai/agents/${agentId}`, agentConfig);
    console.log(`\nUpdated agent ${agentId}.`);
  } else {
    const created = await call('POST', '/v1/convai/agents/create', agentConfig);
    console.log('\nAgent created. Add this line to .env (and to Vercel > Settings > Environment Variables):\n');
    console.log(`ELEVENLABS_AGENT_ID=${created.agent_id}\n`);
  }
}

main().catch((err) => {
  console.error('\nSetup failed:', err?.message || err);
  process.exit(1);
});
