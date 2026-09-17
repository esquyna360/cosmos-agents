import { createSignal } from "solid-js";

const [jumpOpen, setJumpOpen] = createSignal(false);

export { jumpOpen };
export const openJump = () => setJumpOpen(true);
export const closeJump = () => setJumpOpen(false);
