-- ============================================================================
-- GLOBAL HIRE 360 — SUPABASE POSTGRESQL SCHEMA, RELATIONS, SEED DATA & RLS
-- ============================================================================
-- TABLES & RELATIONS IN THIS SCHEMA:
-- 1. public.customer_service_questions (10 Customer Service questions + Marking Guides)
-- 2. public.candidates (Tracks every candidate who fills the check-in form to join the room)
-- 3. public.interview_sessions (Tracks each interview session, linked via candidate_id -> candidates.id)
-- 4. public.candidate_scorecards_summary (Relational view joining candidates + interview_sessions)
-- ============================================================================

-- 1. Customer Service Role Interview Questions & Marking Guide Table
CREATE TABLE IF NOT EXISTS public.customer_service_questions (
  id TEXT PRIMARY KEY,
  role_category TEXT NOT NULL DEFAULT 'Customer Service',
  category TEXT NOT NULL,
  question_text TEXT NOT NULL,
  proposed_answer TEXT NOT NULL,
  expected_focus TEXT NOT NULL,
  is_behavioral_star BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the 10 Official Customer Service / Customer Support Questions & Proposed Answers (Marking Guide)
INSERT INTO public.customer_service_questions (
  id,
  role_category,
  category,
  question_text,
  proposed_answer,
  expected_focus,
  is_behavioral_star
) VALUES
(
  'cs_q1',
  'Customer Service',
  'Customer-Focused Introduction',
  'Tell me about yourself.',
  'I’m a customer-focused professional with experience helping people, solving problems and communicating clearly. In my previous experience, I’ve learned how to stay calm, listen carefully and find practical solutions even when someone is frustrated. One of my strengths is making customers feel heard while still following company policies and procedures. I’m interested in this role because I enjoy helping people and I believe my communication and problem-solving skills would allow me to contribute positively to the team.',
  'Customer-focused mindset, clear communication, staying calm and listening carefully when customers are frustrated, balancing empathy with company policies, and team contribution.',
  FALSE
),
(
  'cs_q2',
  'Customer Service',
  'Motivation for Customer Service',
  'Why do you want to work in customer service?',
  'I enjoy customer service because I like helping people find solutions. I understand that customers may contact a company when something is confusing, inconvenient or frustrating, so I believe patience and clear communication are important. I also enjoy learning about products and processes so I can give accurate information. I’m looking for a role where I can use those skills while continuing to grow professionally.',
  'Genuine passion for helping people find solutions, patience and clear communication with frustrated customers, learning products/processes for accuracy, and professional growth.',
  FALSE
),
(
  'cs_q3',
  'Customer Service',
  'Core Customer Service Strengths',
  'What are your greatest strengths?',
  'My strongest qualities are patience, communication and problem-solving. I’m comfortable listening carefully before responding, which helps me understand what someone actually needs. I also try to stay organized and focused when several requests come in at once. Most importantly, I don’t give up quickly when a problem requires additional research or another approach.',
  'Patience, clear communication, problem-solving, active listening before responding, staying organized across multiple requests, and persistence when researching solutions.',
  FALSE
),
(
  'cs_q4',
  'Customer Service',
  'Stress Management & Prioritization',
  'How do you handle stress?',
  'When work becomes stressful, I first focus on what needs immediate attention and organize the remaining tasks by priority. I try not to let the pressure affect how I communicate with customers or coworkers. If I need clarification or additional support, I communicate that early rather than allowing a problem to grow. Breaking the workload into manageable steps helps me stay productive and maintain quality.',
  'Prioritizing immediate tasks, maintaining calm and respectful communication with customers/coworkers under pressure, asking for clarification early, and breaking work into manageable steps.',
  FALSE
),
(
  'cs_q5',
  'Customer Service',
  'Value Proposition & Professionalism',
  'Why should we hire you?',
  'You should hire me because I bring strong communication, patience and a genuine focus on solving customer problems. I understand that customer service represents the company, so I take professionalism and accuracy seriously. I’m also willing to learn new systems and processes quickly. I would bring a dependable attitude, a willingness to improve and a strong commitment to giving customers a positive experience.',
  'Strong communication, patience, problem-solving focus, representing the company with professionalism and accuracy, quick learning of systems, dependability, and commitment to positive customer experience.',
  FALSE
),
(
  'cs_q6',
  'Customer Service',
  'De-Escalation & Difficult Customers (STAR)',
  'Tell me about a time you dealt with a difficult customer.',
  'Situation: A customer contacted us frustrated because an order had not arrived when expected. Task: My responsibility was to understand what happened and help resolve the issue while following our procedures. Action: I listened carefully without interrupting, apologized for the inconvenience, checked the order information and explained the options available. I also followed up to make sure the correct next step was completed. Result: The customer accepted the solution and the conversation ended much more positively. It reinforced for me that listening and clear communication are extremely important when dealing with difficult situations.',
  'STAR example: listening without interrupting, apologizing empathetically, investigating the issue within procedures, explaining options and following up to achieve a positive outcome.',
  TRUE
),
(
  'cs_q7',
  'Customer Service',
  'Working Under Pressure (STAR)',
  'Tell me about a time you had to work under pressure.',
  'Situation: During a particularly busy period, our team received a much higher volume of customer requests than normal. Task: I needed to keep responses moving while making sure customers received accurate information. Action: I organized requests by urgency, handled the most time-sensitive issues first and used our available resources to work efficiently. When something required additional research, I communicated that clearly instead of rushing an incorrect answer. Result: I was able to complete the priority work on time while maintaining professional communication and accuracy.',
  'STAR example: handling high request volume by triaging urgency, using resources efficiently, communicating transparently rather than rushing wrong answers, and maintaining accuracy on time.',
  TRUE
),
(
  'cs_q8',
  'Customer Service',
  'Accountability & Mistake Recovery (STAR)',
  'Tell me about a time you made a mistake with a customer.',
  'Situation: I once gave a customer incorrect information because I misunderstood part of a process. Task: As soon as I realized the mistake, my responsibility was to correct it quickly and make sure the customer had accurate information. Action: I verified the correct procedure, acknowledged my mistake rather than trying to hide it, contacted the customer with the corrected information and reviewed the process afterward. Result: The customer received the correct guidance, and I changed the way I verified information so I would be less likely to make the same mistake again.',
  'STAR example: acknowledging a mistake honestly instead of hiding it, verifying the correct procedure, proactively correcting the information with the customer, and improving verification habits.',
  TRUE
),
(
  'cs_q9',
  'Customer Service',
  'Complex Problem Solving (STAR)',
  'Describe a time you solved a difficult problem.',
  'Situation: I once handled a customer issue that could not be resolved through the normal first step. Task: I needed to find a practical solution without giving the customer inaccurate information. Action: I gathered the relevant details, checked our available resources, reviewed the possible options and asked for clarification when necessary. I then explained the solution and next steps clearly to the customer. Result: The issue was resolved, and the experience helped me become more comfortable researching problems instead of immediately assuming there was no solution.',
  'STAR example: resolving a non-standard issue by gathering details, researching resources, asking for clarification when needed, and explaining the solution and next steps clearly.',
  TRUE
),
(
  'cs_q10',
  'Customer Service',
  'Turning Negative into Positive (STAR)',
  'Tell me about a time you turned a negative customer experience into a positive one.',
  'Situation: A customer contacted us disappointed because their expectations had not been met. Task: My goal was not only to address the practical issue but also to rebuild their confidence. Action: I listened carefully, acknowledged the concern, explained what I could do and followed through on the solution I promised. I also made sure the customer understood the next step rather than ending the conversation abruptly. Result: The customer became much more satisfied with the interaction, and it reminded me that follow-through can be just as important as the initial solution.',
  'STAR example: rebuilding a disappointed customer''s confidence by listening carefully, acknowledging concerns, following through on promised solutions, and explaining clear next steps.',
  TRUE
)
ON CONFLICT (id) DO UPDATE SET
  category = EXCLUDED.category,
  question_text = EXCLUDED.question_text,
  proposed_answer = EXCLUDED.proposed_answer,
  expected_focus = EXCLUDED.expected_focus,
  is_behavioral_star = EXCLUDED.is_behavioral_star;

-- 2. Candidates Table (Tracks every candidate who fills out the check-in form on /)
CREATE TABLE IF NOT EXISTS public.candidates (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  resume_file_name TEXT,
  extracted_job_position TEXT NOT NULL,
  confirmed_job_position TEXT NOT NULL,
  experience_summary TEXT,
  extracted_skills JSONB DEFAULT '[]'::jsonb,
  agreed_to_instructions BOOLEAN NOT NULL DEFAULT TRUE,
  sessions_count INTEGER NOT NULL DEFAULT 1,
  latest_session_id TEXT,
  latest_session_status TEXT,
  latest_score_out_of_25 NUMERIC(4,1) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidates_email ON public.candidates (email);
CREATE INDEX IF NOT EXISTS idx_candidates_confirmed_job_position ON public.candidates (confirmed_job_position);

-- 3. Interview Sessions Table (1-to-Many relational child of public.candidates via candidate_id)
CREATE TABLE IF NOT EXISTS public.interview_sessions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES public.candidates(id) ON DELETE CASCADE,
  candidate_name TEXT NOT NULL,
  candidate_email TEXT NOT NULL,
  resume_file_name TEXT,
  job_position TEXT NOT NULL,
  experience_summary TEXT,
  key_skills JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  total_score NUMERIC(4,1) NOT NULL DEFAULT 0,
  max_score INTEGER NOT NULL DEFAULT 25,
  percentage_score INTEGER NOT NULL DEFAULT 0,
  successful BOOLEAN NOT NULL DEFAULT FALSE,
  final_impression TEXT,
  question_evaluations JSONB DEFAULT '[]'::jsonb,
  transcript JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Ensure candidate_id foreign key column exists even if public.interview_sessions was created earlier
ALTER TABLE public.interview_sessions
  ADD COLUMN IF NOT EXISTS candidate_id TEXT REFERENCES public.candidates(id) ON DELETE CASCADE;

-- Indexes for relational joins and fast filtering in Supabase
CREATE INDEX IF NOT EXISTS idx_interview_sessions_candidate_id ON public.interview_sessions (candidate_id);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_job_position ON public.interview_sessions (job_position);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_candidate_email ON public.interview_sessions (candidate_email);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_created_at ON public.interview_sessions (created_at DESC);

-- 4. Relational Summary View Joining public.candidates and public.interview_sessions
DROP VIEW IF EXISTS public.candidate_scorecards_summary;
CREATE VIEW public.candidate_scorecards_summary AS
SELECT
  s.id AS session_id,
  s.candidate_id,
  COALESCE(c.full_name, s.candidate_name) AS candidate_name,
  COALESCE(c.email, s.candidate_email) AS candidate_email,
  c.extracted_job_position,
  s.job_position AS interviewed_job_position,
  COALESCE(c.extracted_skills, s.key_skills) AS candidate_skills,
  c.sessions_count AS total_candidate_attempts,
  s.total_score AS score_out_of_25,
  s.percentage_score,
  s.successful,
  s.status,
  s.created_at AS session_started_at,
  s.completed_at AS session_completed_at
FROM public.interview_sessions s
LEFT JOIN public.candidates c ON c.id = s.candidate_id
ORDER BY s.created_at DESC;

-- 5. Row Level Security (RLS) & API Role Grants (for PostgREST / anon / service_role)
ALTER TABLE public.customer_service_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow backend read/write customer_service_questions" ON public.customer_service_questions;
CREATE POLICY "Allow backend read/write customer_service_questions"
  ON public.customer_service_questions
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow backend read/write candidates" ON public.candidates;
CREATE POLICY "Allow backend read/write candidates"
  ON public.candidates
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow backend read/write interview_sessions" ON public.interview_sessions;
CREATE POLICY "Allow backend read/write interview_sessions"
  ON public.interview_sessions
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.customer_service_questions TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.candidates TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.interview_sessions TO anon, authenticated, service_role;
GRANT SELECT ON public.candidate_scorecards_summary TO anon, authenticated, service_role;

-- Reload Supabase PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
