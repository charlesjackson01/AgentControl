import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Most suites assert on the 18 core seeds; vendored-skills tests point
    // AGENTCONTROL_SKILLS_VENDOR_DIR at skills-vendor/ themselves.
    env: { AGENTCONTROL_SKILLS_VENDOR_DIR: 'off' },
    // @vm suites (AC_VM_TESTS=1) share one engine and check that no probe containers are left over,
    // so they run one file at a time; the unit suites stay parallel.
    fileParallelism: process.env.AC_VM_TESTS !== '1',
  },
})
