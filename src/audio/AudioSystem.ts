/** STUB audio — to be replaced by the AUDIO agent. Keeps export `createAudio`. */
import type { AudioApi, CreateAudio } from '../core/contracts';
export const createAudio: CreateAudio = () => {
  const a: AudioApi = {
    async unlock() {}, async load() {}, update() {}, setVolumes() {}, setPaused() {}, playVoice() {}, uiClick() {}, stopAll() {}, dispose() {},
  };
  return a;
};
