-- ============================================================================
-- GLOBAL HIRE 360 — SUPABASE POSTGRESQL SCHEMA, RELATIONS, SEED DATA & RLS
-- ============================================================================
-- TABLES & RELATIONS IN THIS SCHEMA:
-- 1. public.customer_service_questions (legacy: 10 Customer Service questions + Marking Guides)
-- 1b. public.interview_questions (ALL banks: Universal Q1, Customer Service, Virtual Assistant, Technical Support)
-- 1c. public.virtual_assistant_questions (10 Virtual Assistant questions + suggested answers)
-- 1d. public.technical_support_questions (10 IT / Technical Support questions + suggested answers)
-- 2. public.candidates (one row per person — email is the unique identity key)
-- 3. public.interview_sessions (each interview session, linked via candidate_id -> candidates.id)
-- 4. public.candidate_answers (one row per answered question, linked to session + candidate)
-- 5. public.candidate_scorecards_summary (relational view joining candidates + interview_sessions)
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / ON CONFLICT / DROP IF EXISTS).
-- The backend seeds interview_questions automatically on startup.
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

-- 1c. Virtual Assistant Role Interview Questions & Suggested Answers (Marking Guide)
CREATE TABLE IF NOT EXISTS public.virtual_assistant_questions (
  id TEXT PRIMARY KEY,
  role_category TEXT NOT NULL DEFAULT 'Virtual Assistant',
  category TEXT NOT NULL,
  question_text TEXT NOT NULL,
  proposed_answer TEXT NOT NULL,
  expected_focus TEXT NOT NULL,
  is_behavioral_star BOOLEAN NOT NULL DEFAULT FALSE,
  marking_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the 10 Virtual Assistant questions & suggested answers
INSERT INTO public.virtual_assistant_questions (
  id, role_category, category, question_text, proposed_answer, expected_focus, is_behavioral_star, marking_points
) VALUES
(
  'va_q1',
  'Virtual Assistant',
  'Organization, Time Management & Core VA Skills',
  'Tell me about yourself.',
  'I’m an organized and dependable professional who enjoys keeping tasks, information and communication moving efficiently. My strengths include attention to detail, time management and learning new tools quickly. I’m comfortable working with documents, schedules, email, data and multiple priorities. I’m interested in administrative or virtual assistant work because I enjoy creating structure and making it easier for a team to stay organized and productive.',
  'Organized and dependable mindset, attention to detail, time management, quick learning of new software, comfort with schedules, email, data, and creating structure to keep a team productive.',
  FALSE,
  '["Organized and dependable professional managing tasks & communication","Attention to detail, time management & learning new tools quickly","Comfort with documents, schedules, email, data & multiple priorities","Creating structure to make a team organized and productive"]'::jsonb
),
(
  'va_q2',
  'Virtual Assistant',
  'Urgency, Deadlines & Work Prioritization',
  'How do you prioritize your work?',
  'I prioritize tasks based on urgency, importance and deadlines. I first identify anything time-sensitive or affecting other people, then I organize the remaining work into a clear list. If two priorities conflict, I communicate with the appropriate person rather than making assumptions. I also leave some flexibility for unexpected requests while still protecting important deadlines.',
  'Prioritization based on urgency, importance, and deadlines; identifying time-sensitive items affecting others first; proactive communication when priorities clash; and flexibility for unexpected tasks.',
  FALSE,
  '["Prioritizing based on urgency, importance and deadlines","Identifying time-sensitive items affecting other people first","Communicating proactively rather than making assumptions during conflict","Maintaining flexibility for unexpected requests while protecting deadlines"]'::jsonb
),
(
  'va_q3',
  'Virtual Assistant',
  'Attention to Detail & Quality Review',
  'How do you make sure your work is accurate?',
  'I build a review step into my workflow rather than assuming the first version is perfect. Depending on the task, I check names, numbers, dates, formatting and source information, and I use tools such as spellcheck when appropriate. For important work, I do a final review from the perspective of the person who will receive it. This helps me catch small errors before they become bigger problems.',
  'Building an intentional review step into the workflow; verifying names, numbers, dates, formatting, and source data; leveraging tools; and reviewing through the recipient''s perspective to catch errors early.',
  FALSE,
  '["Building a review step into the workflow","Auditing names, numbers, dates, formatting & source information","Utilizing proofreading & validation tools (e.g. spellcheck)","Reviewing through the recipient''s perspective to catch errors early"]'::jsonb
),
(
  'va_q4',
  'Virtual Assistant',
  'Software Adaptability & Self-Guided Learning',
  'How do you learn a new software tool quickly?',
  'When I need to learn a new tool, I first identify the tasks I will actually need to perform with it. I learn the basic workflow, practice those tasks and use documentation or tutorials when I get stuck. I also take notes on important steps so I don’t have to repeatedly ask the same question. Once I understand the basics, I look for shortcuts and features that improve efficiency.',
  'Targeting required tasks first, practicing core workflows with documentation/tutorials, taking structured notes to retain steps, and looking for shortcuts/features that improve efficiency.',
  FALSE,
  '["Identifying specific tasks required for the workflow","Hands-on practice using documentation and tutorials","Taking structured notes to remember key steps independently","Finding shortcuts and features to improve efficiency"]'::jsonb
),
(
  'va_q5',
  'Virtual Assistant',
  'Reliability, Administrative Value & Adaptability',
  'Why should we hire you?',
  'You should hire me because I’m organized, dependable and focused on completing work accurately. I understand that administrative support often involves many small details, deadlines and communication points, and I take those responsibilities seriously. I’m also comfortable learning new systems and adjusting when priorities change. My goal would be to become someone the team can trust to keep tasks moving and details under control.',
  'Organized and dependable mindset; taking ownership of small details, deadlines, and communications; adaptability to new systems; and becoming a trusted partner who keeps tasks under control.',
  FALSE,
  '["Organized, dependable and focused on accuracy","Taking ownership of small details, deadlines & communication points","Comfortable learning new systems and adjusting when priorities change","Becoming someone the team can trust to keep tasks under control"]'::jsonb
),
(
  'va_q6',
  'Virtual Assistant',
  'Managing Multiple Deadlines (STAR)',
  'Tell me about a time you had multiple deadlines at once.',
  'Situation: I had several important assignments with deadlines that were close together. Task: I needed to complete each one accurately without allowing one deadline to interfere with another. Action: I listed all deliverables, identified which tasks were most urgent and which depended on other work, and then created a schedule with focused blocks of time. When I saw a potential conflict, I communicated early instead of waiting until the deadline was close. Result: I completed the priority work on time and maintained quality across the remaining assignments.',
  'STAR example: several close deadlines, listing deliverables, identifying urgency and dependencies, scheduling focused time blocks, communicating potential conflicts early, and delivering priority work on time without losing quality.',
  TRUE,
  '["Situation/Task: several close deadlines that all had to be met accurately","Action: listed deliverables, judged urgency & dependencies, scheduled focused time blocks","Action: communicated potential conflicts early instead of waiting","Result: priority work delivered on time with quality maintained"]'::jsonb
),
(
  'va_q7',
  'Virtual Assistant',
  'Catching Mistakes & Quality Control (STAR)',
  'Describe a time you caught an important mistake before it caused a problem.',
  'Situation: While reviewing a document before it was finalized, I noticed that one piece of information did not match the original source. Task: I needed to determine whether it was an error and correct it before the document moved forward. Action: I went back to the source, verified the information and updated the document before submission. I then reviewed the surrounding information to make sure there were no related errors. Result: The mistake was corrected before it caused a problem, and it reinforced for me why a final quality check is important even when a task appears finished.',
  'STAR example: noticing a mismatch during a review, checking it against the original source, correcting it before submission, reviewing related information for further errors, and valuing a final quality check.',
  TRUE,
  '["Situation: noticed information that did not match during a review","Action: went back to the source and verified the information","Action: corrected it before submission & checked for related errors","Result: problem prevented & value of a final quality check"]'::jsonb
),
(
  'va_q8',
  'Virtual Assistant',
  'Organizing a Difficult Task (STAR)',
  'Describe a time you had to organize a difficult task.',
  'Situation: I was given a task that involved several pieces of information and multiple steps, and it initially felt difficult to organize. Task: I needed to create enough structure to complete it accurately and on time. Action: I broke the project into smaller steps, created a checklist, identified which items depended on others and tracked progress as I worked. Result: The task became much more manageable, I was able to keep track of the details and the work was completed successfully.',
  'STAR example: a complex multi-step task, creating structure, breaking it into smaller steps, using a checklist, identifying dependencies, tracking progress, and completing it accurately and on time.',
  TRUE,
  '["Situation/Task: a complex, multi-step task that needed structure","Action: broke it into smaller steps and created a checklist","Action: identified dependencies and tracked progress","Result: task became manageable and was completed successfully"]'::jsonb
),
(
  'va_q9',
  'Virtual Assistant',
  'Working Independently (STAR)',
  'Tell me about a time you had to work independently.',
  'Situation: I was assigned a task while the person who normally provided guidance was not immediately available. Task: I needed to keep the work moving without making decisions outside my responsibility. Action: I reviewed the information I already had, used available resources to answer routine questions and identified the few items that genuinely required clarification. I communicated those questions clearly and continued with the work I could complete independently. Result: The task was completed successfully and I became more confident in knowing when to act independently and when to ask for help.',
  'STAR example: working without immediate guidance, keeping work moving within your responsibility, using available resources for routine questions, isolating the few items needing clarification, communicating clearly, and knowing when to ask for help.',
  TRUE,
  '["Situation/Task: no immediate guidance, but work had to keep moving within your responsibility","Action: used available information & resources for routine questions","Action: identified what truly needed clarification and communicated it clearly","Result: task completed & confidence in when to act alone vs. ask for help"]'::jsonb
),
(
  'va_q10',
  'Virtual Assistant',
  'Learning a New Tool Quickly (STAR)',
  'Tell me about a time you had to learn a new tool quickly.',
  'Situation: I was asked to use a software tool that I had not worked with before. Task: I needed to learn the functions required for my work quickly so the project would not be delayed. Action: I focused first on the specific tasks I needed to perform, used available tutorials and documentation, practiced the workflow and wrote down important steps. Once I was comfortable with the basics, I explored shortcuts that could improve my efficiency. Result: I became productive with the tool quickly and was able to complete the required work without depending on someone else for every step.',
  'STAR example: unfamiliar software needed quickly, focusing on the tasks actually required, using tutorials and documentation, practicing and writing down steps, exploring shortcuts, and becoming productive without depending on others.',
  TRUE,
  '["Situation/Task: unfamiliar tool that had to be learned quickly to avoid delays","Action: focused on required tasks using tutorials & documentation","Action: practiced the workflow, noted key steps, then explored shortcuts","Result: became productive quickly without depending on others"]'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  role_category = EXCLUDED.role_category,
  category = EXCLUDED.category,
  question_text = EXCLUDED.question_text,
  proposed_answer = EXCLUDED.proposed_answer,
  expected_focus = EXCLUDED.expected_focus,
  is_behavioral_star = EXCLUDED.is_behavioral_star,
  marking_points = EXCLUDED.marking_points;

-- 1d. IT / Technical Support Role Interview Questions & Suggested Answers (Marking Guide)
CREATE TABLE IF NOT EXISTS public.technical_support_questions (
  id TEXT PRIMARY KEY,
  role_category TEXT NOT NULL DEFAULT 'Technical Support',
  category TEXT NOT NULL,
  question_text TEXT NOT NULL,
  proposed_answer TEXT NOT NULL,
  expected_focus TEXT NOT NULL,
  is_behavioral_star BOOLEAN NOT NULL DEFAULT FALSE,
  marking_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the 10 IT / Technical Support questions & suggested answers
INSERT INTO public.technical_support_questions (
  id, role_category, category, question_text, proposed_answer, expected_focus, is_behavioral_star, marking_points
) VALUES
(
  'it_q1',
  'Technical Support',
  'Technical Support Introduction',
  'Tell me about yourself.',
  'I’m a technically minded professional who enjoys troubleshooting problems and helping people use technology effectively. I’m comfortable researching issues, following logical troubleshooting steps and learning new systems. I also understand that technical support is not only about fixing the technology — it is about communicating clearly with the person experiencing the problem. I’m interested in this role because it would allow me to combine problem-solving with customer support.',
  'Technically minded, enjoys troubleshooting and helping people use technology, researching issues and following logical steps, learning new systems, communicating clearly with users, and combining problem-solving with customer support.',
  FALSE,
  '["Technically minded & enjoys troubleshooting problems","Research, logical troubleshooting steps & learning new systems","Support is also about communicating clearly with the user","Motivation: combining problem-solving with customer support"]'::jsonb
),
(
  'it_q2',
  'Technical Support',
  'Structured Troubleshooting Method',
  'How do you troubleshoot a technical problem?',
  'I start by clearly defining the problem and gathering information about what changed, what the user sees and when the issue started. Then I try to isolate the cause by testing the most likely possibilities one at a time. I avoid making several changes at once because that can make the problem harder to diagnose. After applying a solution, I verify that the issue is actually resolved and document the steps when appropriate.',
  'Defining the problem and gathering information (what changed, what the user sees, when it started), isolating the cause by testing likely possibilities one at a time, avoiding multiple simultaneous changes, verifying the fix, and documenting steps.',
  FALSE,
  '["Define the problem & gather information (what changed, what the user sees, when it started)","Isolate the cause by testing likely possibilities one at a time","Avoid making several changes at once","Verify the fix & document the steps"]'::jsonb
),
(
  'it_q3',
  'Technical Support',
  'Learning New Technology',
  'How do you learn new technology quickly?',
  'I focus first on understanding what I need the technology to accomplish rather than trying to learn every feature at once. I use official documentation, tutorials or knowledge bases, then practice the most common workflows. If I run into a problem, I research the specific issue and ask targeted questions when necessary. Once I understand the basics, I continue learning through hands-on use.',
  'Focusing on what the technology must accomplish instead of every feature, using official documentation, tutorials and knowledge bases, practicing common workflows, researching specific issues and asking targeted questions, and continuing through hands-on use.',
  FALSE,
  '["Focus on what the technology needs to accomplish, not every feature","Use official documentation, tutorials or knowledge bases","Practice common workflows; research specific issues & ask targeted questions","Keep learning through hands-on use"]'::jsonb
),
(
  'it_q4',
  'Technical Support',
  'Handling Frustrated Users',
  'How do you handle a frustrated user?',
  'I first let the user explain the issue without interrupting and acknowledge the frustration. Then I ask focused questions so I can understand the technical problem. I explain what I’m going to check in simple language rather than using unnecessary technical terms. Once I identify the solution, I guide the user through it clearly and confirm that the issue is resolved before ending the interaction.',
  'Letting the user explain without interrupting, acknowledging the frustration, asking focused questions, explaining checks in simple language without jargon, guiding the user through the fix, and confirming resolution before ending.',
  FALSE,
  '["Let the user explain without interrupting & acknowledge the frustration","Ask focused questions to understand the technical problem","Explain checks in simple language without unnecessary jargon","Guide them through the fix & confirm it is resolved before ending"]'::jsonb
),
(
  'it_q5',
  'Technical Support',
  'Value Proposition for Technical Support',
  'Why should we hire you for technical support?',
  'You should hire me because I combine technical problem-solving with patience and communication. I approach issues logically instead of guessing, and I’m comfortable researching unfamiliar problems when I don’t immediately know the answer. I also understand that users need clear explanations, not just technical jargon. I would bring a dependable attitude, a willingness to keep learning and a focus on resolving issues effectively.',
  'Combining technical problem-solving with patience and communication, a logical approach instead of guessing, comfort researching unfamiliar problems, clear explanations instead of jargon, dependability, willingness to learn and a focus on resolving issues.',
  FALSE,
  '["Technical problem-solving combined with patience & communication","Logical approach & comfortable researching unfamiliar problems","Clear explanations for users, not just technical jargon","Dependable, keeps learning, focused on resolving issues"]'::jsonb
),
(
  'it_q6',
  'Technical Support',
  'Solving a Difficult Technical Problem (STAR)',
  'Tell me about a difficult technical problem you solved.',
  'Situation: A user reported a technical issue that was not resolved by the normal first troubleshooting steps. Task: I needed to identify the likely cause and restore the user''s ability to work. Action: I gathered information about when the issue started and what the user had already tried. I then isolated the problem by testing the likely causes one at a time rather than changing several things simultaneously. Once I identified the cause, I applied the appropriate fix and tested the system again. Result: The issue was resolved, the user was able to continue working and I documented the solution so it could be referenced if the problem appeared again.',
  'STAR example: issue not fixed by first-line steps, gathering when it started and what was tried, isolating causes one at a time, applying the fix and retesting, restoring the user, and documenting the solution.',
  TRUE,
  '["Situation/Task: issue not fixed by normal first steps; restore the user’s ability to work","Action: gathered information — when it started & what was already tried","Action: isolated the cause one at a time, applied the fix & retested","Result: issue resolved, user back to work & solution documented"]'::jsonb
),
(
  'it_q7',
  'Technical Support',
  'Troubleshooting Under Pressure (STAR)',
  'Describe a time you had to troubleshoot under pressure.',
  'Situation: A technical issue occurred during a time-sensitive period and was affecting an important task. Task: I needed to restore functionality quickly without making the situation worse. Action: I stayed calm, identified the immediate impact, gathered the key facts and focused first on the most likely causes. I tested solutions in a controlled way and communicated updates so the user knew what was happening. Result: The issue was resolved within the available time, and the user was able to continue the task. The experience reinforced the importance of staying methodical even when the situation feels urgent.',
  'STAR example: time-sensitive outage affecting an important task, restoring function quickly without making it worse, staying calm, identifying impact and key facts, testing likely causes in a controlled way, communicating updates, and staying methodical.',
  TRUE,
  '["Situation/Task: time-sensitive issue; restore quickly without making it worse","Action: stayed calm, identified the impact & gathered key facts","Action: tested likely causes in a controlled way & communicated updates","Result: resolved in time & lesson about staying methodical"]'::jsonb
),
(
  'it_q8',
  'Technical Support',
  'Learning New Technology Quickly (STAR)',
  'Tell me about a time you learned a new technology quickly.',
  'Situation: I was required to work with a technology that I had not used before. Task: I needed to become productive with the core functions quickly. Action: I identified exactly what I needed to accomplish, reviewed the available documentation, practiced the workflow and researched specific questions as they came up. I focused on understanding why the system worked the way it did instead of simply memorizing clicks. Result: I became comfortable enough to complete the required work quickly and continued building my knowledge through hands-on use.',
  'STAR example: unfamiliar technology needed quickly, identifying what had to be accomplished, reviewing documentation, practicing the workflow, researching questions as they arose, understanding why the system works rather than memorizing clicks, and continued hands-on learning.',
  TRUE,
  '["Situation/Task: unfamiliar technology with core functions needed quickly","Action: identified goals, reviewed documentation & practiced the workflow","Action: researched questions & understood why the system works (not memorizing clicks)","Result: productive quickly & kept learning hands-on"]'::jsonb
),
(
  'it_q9',
  'Technical Support',
  'Supporting a Frustrated User (STAR)',
  'Describe a time you dealt with a frustrated user.',
  'Situation: A user was frustrated because a technical problem was preventing them from completing an important task. Task: I needed to troubleshoot the issue while keeping the interaction professional and productive. Action: I let the user explain what was happening, acknowledged the frustration and asked focused questions to narrow down the problem. I explained the troubleshooting steps in simple language and kept the user updated instead of leaving them wondering what was happening. Result: We identified and resolved the issue, and the user understood what had been done. It reminded me that good technical support requires both technical reasoning and empathy.',
  'STAR example: frustrated user blocked from an important task, keeping it professional, letting them explain, acknowledging frustration, focused questions, simple-language explanations and regular updates, resolving the issue, and balancing technical reasoning with empathy.',
  TRUE,
  '["Situation/Task: frustrated user blocked from an important task; keep it professional","Action: let them explain, acknowledged frustration & asked focused questions","Action: explained steps in simple language & kept the user updated","Result: resolved, user understood the fix & lesson: reasoning plus empathy"]'::jsonb
),
(
  'it_q10',
  'Technical Support',
  'Technical Mistake & Correction (STAR)',
  'Tell me about a technical mistake you made and how you corrected it.',
  'Situation: I once made a technical change that produced an unexpected result. Task: I needed to identify what happened, minimize the impact and restore the correct configuration. Action: I stopped making additional changes, reviewed the steps I had taken, corrected or restored the affected setting and then tested the system carefully before continuing. I also documented what happened and added an extra verification step to my process. Result: The issue was corrected, and the experience taught me to slow down and verify changes rather than assuming a configuration change will behave exactly as expected.',
  'STAR example: a change with an unexpected result, owning it, minimizing impact, stopping further changes, reviewing the steps taken, restoring the correct setting and retesting, documenting it, adding a verification step, and learning to verify changes.',
  TRUE,
  '["Situation/Task: own technical change caused an unexpected result; minimize impact","Action: stopped further changes & reviewed the steps taken","Action: restored the correct setting, retested & documented it","Result: corrected & added a verification step — slow down and verify changes"]'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  role_category = EXCLUDED.role_category,
  category = EXCLUDED.category,
  question_text = EXCLUDED.question_text,
  proposed_answer = EXCLUDED.proposed_answer,
  expected_focus = EXCLUDED.expected_focus,
  is_behavioral_star = EXCLUDED.is_behavioral_star,
  marking_points = EXCLUDED.marking_points;

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

-- Columns added for duplicate detection, /20 scoring and returning-candidate logic
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS normalized_name TEXT;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS completed_sessions_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS latest_score_out_of_20 NUMERIC(4,1) DEFAULT 0;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;

-- Normalize existing emails so the UNIQUE(email) constraint also prevents case-variant duplicates
-- (rows whose lowercase email already exists are left untouched to avoid a unique violation)
UPDATE public.candidates c
  SET email = LOWER(TRIM(c.email))
  WHERE c.email <> LOWER(TRIM(c.email))
    AND NOT EXISTS (SELECT 1 FROM public.candidates d WHERE d.email = LOWER(TRIM(c.email)));
UPDATE public.candidates
  SET normalized_name = LOWER(REGEXP_REPLACE(TRIM(full_name), '\s+', ' ', 'g'))
  WHERE normalized_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_candidates_email ON public.candidates (email);
CREATE INDEX IF NOT EXISTS idx_candidates_normalized_name ON public.candidates (normalized_name);
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
  max_score INTEGER NOT NULL DEFAULT 20,
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

-- Columns added for 4-5 question sessions, returning candidates and single-send result emails
ALTER TABLE public.interview_sessions ALTER COLUMN max_score SET DEFAULT 20;
ALTER TABLE public.interview_sessions ADD COLUMN IF NOT EXISTS current_phase TEXT;
ALTER TABLE public.interview_sessions ADD COLUMN IF NOT EXISTS question_count INTEGER NOT NULL DEFAULT 4;
ALTER TABLE public.interview_sessions ADD COLUMN IF NOT EXISTS is_first_time_candidate BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.interview_sessions ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE public.interview_sessions ADD COLUMN IF NOT EXISTS email_sent BOOLEAN NOT NULL DEFAULT FALSE;

-- Indexes for relational joins and fast filtering in Supabase
CREATE INDEX IF NOT EXISTS idx_interview_sessions_candidate_id ON public.interview_sessions (candidate_id);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_job_position ON public.interview_sessions (job_position);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_candidate_email ON public.interview_sessions (candidate_email);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_created_at ON public.interview_sessions (created_at DESC);

-- 1b. All interview question banks & marking guides (seeded automatically by the backend)
CREATE TABLE IF NOT EXISTS public.interview_questions (
  id TEXT PRIMARY KEY,
  role_category TEXT NOT NULL,
  category TEXT NOT NULL,
  question_text TEXT NOT NULL,
  proposed_answer TEXT NOT NULL,
  expected_focus TEXT NOT NULL,
  is_behavioral_star BOOLEAN NOT NULL DEFAULT FALSE,
  alternative_wordings JSONB NOT NULL DEFAULT '[]'::jsonb,
  marking_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_interview_questions_role ON public.interview_questions (role_category);

-- 3b. Candidate Answers: one row per answered question of every interview
--     (unique per session + question number, so re-saving updates instead of duplicating)
CREATE TABLE IF NOT EXISTS public.candidate_answers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES public.candidates(id) ON DELETE CASCADE,
  candidate_email TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  job_position TEXT NOT NULL,
  question_id TEXT,
  question_number INTEGER NOT NULL,
  question_category TEXT,
  question_text TEXT NOT NULL,
  candidate_answer TEXT,
  suggested_answer TEXT,
  score_out_of_5 NUMERIC(3,1) NOT NULL DEFAULT 0,
  score_contribution_out_of_20 NUMERIC(5,2) NOT NULL DEFAULT 0,
  alignment_percent INTEGER,
  matched_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  missed_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  feedback TEXT,
  improvement_tip TEXT,
  attempts_used INTEGER NOT NULL DEFAULT 0,
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  grading_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT candidate_answers_session_question_unique UNIQUE (session_id, question_number)
);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_candidate_id ON public.candidate_answers (candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_email ON public.candidate_answers (candidate_email);
CREATE INDEX IF NOT EXISTS idx_candidate_answers_question_id ON public.candidate_answers (question_id);

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
  s.total_score AS score_out_of_20,
  s.max_score,
  s.question_count,
  s.is_first_time_candidate,
  s.email_status,
  s.percentage_score,
  s.successful,
  s.status,
  s.created_at AS session_started_at,
  s.completed_at AS session_completed_at
FROM public.interview_sessions s
LEFT JOIN public.candidates c ON c.id = s.candidate_id
ORDER BY s.created_at DESC;

-- 5. Row Level Security (RLS) & API Role Grants
-- SECURITY: only the backend (service_role key, which bypasses RLS) may read or write.
-- The public anon / authenticated roles get NO access, so the anon key shipped in any
-- frontend bundle cannot be used to read candidate emails, transcripts or answers,
-- or to tamper with scores.
ALTER TABLE public.customer_service_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.virtual_assistant_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technical_support_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_answers ENABLE ROW LEVEL SECURITY;

-- Remove the old wide-open policies (they allowed anon full read/write)
DROP POLICY IF EXISTS "Allow backend read/write customer_service_questions" ON public.customer_service_questions;
DROP POLICY IF EXISTS "Allow backend read/write candidates" ON public.candidates;
DROP POLICY IF EXISTS "Allow backend read/write interview_sessions" ON public.interview_sessions;

REVOKE ALL ON TABLE public.customer_service_questions FROM anon, authenticated;
REVOKE ALL ON TABLE public.interview_questions FROM anon, authenticated;
REVOKE ALL ON TABLE public.virtual_assistant_questions FROM anon, authenticated;
REVOKE ALL ON TABLE public.technical_support_questions FROM anon, authenticated;
REVOKE ALL ON TABLE public.candidates FROM anon, authenticated;
REVOKE ALL ON TABLE public.interview_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.candidate_answers FROM anon, authenticated;
REVOKE ALL ON public.candidate_scorecards_summary FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON TABLE public.customer_service_questions TO service_role;
GRANT ALL ON TABLE public.interview_questions TO service_role;
GRANT ALL ON TABLE public.virtual_assistant_questions TO service_role;
GRANT ALL ON TABLE public.technical_support_questions TO service_role;
GRANT ALL ON TABLE public.candidates TO service_role;
GRANT ALL ON TABLE public.interview_sessions TO service_role;
GRANT ALL ON TABLE public.candidate_answers TO service_role;
GRANT SELECT ON public.candidate_scorecards_summary TO service_role;

-- The view runs with the caller's permissions (Postgres 15+), so it can never bypass RLS.
ALTER VIEW public.candidate_scorecards_summary SET (security_invoker = true);

-- Reload Supabase PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';
