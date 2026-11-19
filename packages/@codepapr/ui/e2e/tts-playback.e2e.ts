import { test, expect, configureVoiceTest } from './fixtures';

const sentences = [
  '第一句，我们沿着河边的小路一直往前走。',
  '第二句，公园里有许多鲜花和高大的树木。',
  '第三句，远处的孩子们正在草地上放风筝。',
  '第四句，回家以前记得去面包店买点心',
];

for (const mode of ['whole', 'streamed-pipeline', 'streamed-pcm', 'ws-batch'] as const) {
  test(`chat plays and replays every sentence at 16 steps in ${mode} mode`, async ({ page }) => {
    await configureVoiceTest(page, mode);
    await page.goto('/');
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await page.getByTitle('Cancel', { exact: true }).click();
    await expect(page.getByTitle(/Show TTS server log/)).toBeVisible();
    await page.evaluate(async (playbackMode) => {
      const agentModule = '/src/store/agentStore.ts';
      const { useAgentStore } = await import(agentModule);
      // @ts-expect-error injected by tauriMock
      const mock = window.__CODEPAPR_E2E__;
      const calls: unknown[] = [];
      let resume: (() => void) | undefined;
      const record = (cmd: string) => (args: unknown) => {
        calls.push({ cmd, args });
        if (calls.length === 1 && playbackMode === 'ws-batch') {
          return new Promise<void>((resolve) => { resume = resolve; });
        }
      };
      mock.setHandler('tts_synthesize_batch_ws', record('tts_synthesize_batch_ws'));
      mock.setHandler('tts_synthesize_batch_ws_nonblocking', record('tts_synthesize_batch_ws_nonblocking'));
      mock.setHandler('tts_synthesize_and_play', record('tts_synthesize_and_play'));
      mock.setHandler('qa_resume_voice', () => resume?.());
      mock.setHandler('qa_voice_calls', () => calls);
      mock.setHandler('qa_message', ({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
        useAgentStore.setState({
          messages: [{ id: 'speech-qa', role: 'assistant', content, isStreaming, timestamp: Date.now() }],
        });
      });
    }, mode);
    const feed = (parts: string[], isStreaming: boolean) => page.evaluate(
      ({ content, isStreaming }) => window.__TAURI_INTERNALS__.invoke('qa_message', { content, isStreaming }),
      { content: parts.join(''), isStreaming },
    );
    const readCalls = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke<
      { cmd: string; args: { text?: string; sentences?: string[]; sampleSteps: number; playbackMode?: string } }[]
    >('qa_voice_calls'));
    await feed(sentences.slice(0, 1), true);
    await expect(page.getByText(sentences[0], { exact: true })).toBeVisible();
    await expect.poll(async () => (await readCalls()).length).toBe(mode === 'whole' ? 0 : 1);

    await feed(sentences, true);
    await expect(page.getByText(sentences.join(''), { exact: true })).toBeVisible();
    await feed(sentences, false);
    if (mode === 'ws-batch') {
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('qa_resume_voice'));
    }

    const expectedCalls = mode === 'whole' ? 1 : mode === 'ws-batch' ? 2 : 4;
    await expect.poll(async () => (await readCalls()).length).toBe(expectedCalls);
    const verify = (calls: Awaited<ReturnType<typeof readCalls>>) => {
      expect(calls.map(({ args }) => args.sentences?.join('') ?? args.text).join('')).toBe(sentences.join(''));
      expect(calls.every(({ args }) => args.sampleSteps === 16)).toBe(true);
      if (mode === 'ws-batch') {
        expect(calls.every(({ cmd }) => cmd === 'tts_synthesize_batch_ws')).toBe(true);
        expect(calls.flatMap(({ args }) => args.sentences)).toEqual(sentences);
      } else {
        expect(calls.every(({ args }) => args.playbackMode === mode)).toBe(true);
      }
    };
    verify(await readCalls());

    const replay = page.getByRole('button', { name: 'Replay', exact: true });
    await replay.locator('../..').hover();
    await replay.click();
    await expect.poll(async () => (await readCalls()).length).toBe(expectedCalls * 2);
    verify((await readCalls()).slice(expectedCalls));
  });
}
