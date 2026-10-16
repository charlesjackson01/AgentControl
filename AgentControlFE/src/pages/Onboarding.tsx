import { useNavigate } from 'react-router-dom'
import { SparkIcon } from '../components/icons'
import UserProfileForm from '../components/UserProfileForm'
import type { UserProfile } from '../lib/types'

/**
 * First run (profile.onboardedAt === null): name + avatar before the app.
 * Order: profile first; afterwards "/" lands on Primary's DM, or /agents, whose
 * existing bootstrap form creates the Team Lead when the workspace has no agents.
 */
export default function Onboarding({ profile, onDone }: { profile: UserProfile; onDone: (p: UserProfile) => void }) {
  const navigate = useNavigate()
  return (
    <main className="page onboarding">
      <div className="page__inner page__inner--narrow setup">
        <div className="formpage__head">
          <span className="detail__icon">
            <SparkIcon size={22} />
          </span>
          <div>
            <p className="page__eyebrow">Welcome to AgentControl</p>
            <h1 className="detail__name">Let’s set up your profile</h1>
            <p className="page__sub">Your agents will know you by this. You can change it any time in Settings.</p>
          </div>
        </div>
        <section className="formcard">
          <div className="formsection">
            <UserProfileForm
              profile={profile}
              onboarding
              submitLabel="Continue"
              onSaved={(p) => {
                onDone(p)
                navigate('/', { replace: true })
              }}
            />
          </div>
        </section>
      </div>
    </main>
  )
}
