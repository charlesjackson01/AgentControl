import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Most suites assert on the 18 core seeds; vendored-skills tests point
    // AGENTCONTROL_SKILLS_VENDOR_DIR at skills-vendor/ themselves.
    env: { AGENTCONTROL_SKILLS_VENDOR_DIR: 'off' },
  },
})
