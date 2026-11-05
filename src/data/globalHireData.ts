export interface InterviewQuestion {
  id: string;
  phaseNumber: number;
  phaseTitle: string;
  sourcePage: 'interview-helper' | 'candidate-workshop' | 'role-assessment';
  sourceUrl: string;
  question: string;
  whyWeAsk: string;
  whatGoodLooksLike: string[];
  recommendedFramework: string;
  sampleStrongAnswer: string;
}

export interface RoleTrack {
  id: string;
  title: string;
  courseSlug: string;
  summary: string;
  typicalDuties: string;
  keySkills: string[];
  roleQuestions: InterviewQuestion[];
}

export const GLOBAL_HIRE_SOURCE_LINKS = [
  {
    id: 'main',
    title: 'Global Hire 360 Main Platform',
    url: 'https://www.globalhire360.com/',
    readingTime: '6 min read',
    focus: '40+ remote role types, 3-step verified candidate matching, and international employer placement.',
    extractedHighlights: [
      'Pre-screened, English-fluent remote candidates matched directly with global employers',
      'Step 1: Role-Based Skills Assessment (maximum 2 attempts; passcode required for Step 4 Interview)',
      'Step 2: Account & Identity Verification ($10 one-time Verified Candidate platform access)',
      'Step 3: Verified Dashboard & Direct Employer Matching across 7 core operational tracks',
    ],
  },
  {
    id: 'interview-helper',
    title: 'Interactive Interview Helper',
    url: 'https://www.globalhire360.com/interview-helper/',
    readingTime: '7 min read',
    focus: 'Structured STAR behavioral questions, Workplace English clarity, and remote work reliability.',
    extractedHighlights: [
      'Evaluates spoken and written Workplace English clarity for international client communication',
      'Drills candidates on the STAR framework (Situation, Task, Action, Result) for behavioral questions',
      'Tests independent troubleshooting during remote technical breakdowns or ambiguous instructions',
      'Prepares candidates for synchronous video interviews and asynchronous team updates',
    ],
  },
  {
    id: 'candidate-workshop',
    title: 'Saturday Candidate Workshop',
    url: 'https://www.globalhire360.com/candidate-workshop/',
    readingTime: '6 min read',
    focus: 'Live platform navigation, dashboard hiring statuses, onboarding compliance, and matching readiness.',
    extractedHighlights: [
      'Explains official Dashboard Statuses: NOT MATCHING · MATCHING · MATCHED · OFFER ACCEPTED · HIRED',
      'Verifies 100% completion of Workforce English ("Mark Complete" on every lesson)',
      'Enforces strict ID security rules (upload government ID only in private portal, never in group chat)',
      'Covers post-interview status checks, case-sensitive Step 4 passcodes, and employer expectation alignment',
    ],
  },
];

export const CORE_INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'ih-1',
    phaseNumber: 1,
    phaseTitle: 'Phase 1: Profile Alignment & Workplace English Warm-Up',
    sourcePage: 'interview-helper',
    sourceUrl: 'https://www.globalhire360.com/interview-helper/',
    question:
      'Walk us through your professional background and explain what makes you ready to work remotely for an international employer through Global Hire 360.',
    whyWeAsk:
      'Evaluates your baseline Workplace English clarity, professional confidence, and how clearly you connect your past work to remote employer needs.',
    whatGoodLooksLike: [
      'Summarizes 2–3 relevant past roles or core strengths in plain, confident English',
      'Mentions specific remote tools or workflows you have used (e.g., Zoom, Slack, CRM, Google Workspace)',
      'Focuses on reliability and value delivered to employers rather than personal convenience',
    ],
    recommendedFramework: 'Present – Past – Remote Readiness',
    sampleStrongAnswer:
      'Over the past four years, I have worked in client-facing support and administrative coordination, managing high-volume email, shared calendars, and CRM records. In my last role, I collaborated daily with team members across three time zones using Slack, Zoom, and Google Workspace, maintaining a 98% customer satisfaction score. I am ready for a Global Hire 360 remote placement because I have a quiet, dedicated home office, reliable high-speed internet with a backup connection, and proven discipline in meeting daily KPIs without micromanagement.',
  },
  {
    id: 'ih-2',
    phaseNumber: 2,
    phaseTitle: 'Phase 2: Remote Work Competency & Self-Management',
    sourcePage: 'interview-helper',
    sourceUrl: 'https://www.globalhire360.com/interview-helper/',
    question:
      'How do you structure your workday when working from home, and what steps do you take if you face a technical issue or unclear instructions when your manager is in a different time zone?',
    whyWeAsk:
      'Global Hire 360 employers rely on self-managed professionals who do not stall when working asynchronously across borders.',
    whatGoodLooksLike: [
      'Describes a concrete daily routine (time-blocking, task prioritization, end-of-day reporting)',
      'Shows proactive problem-solving before escalating (checking documentation, testing backup connections)',
      'Explains how to write a clear, actionable async update so the manager can respond quickly',
    ],
    recommendedFramework: 'Routine – Troubleshoot – Communicate Proactively',
    sampleStrongAnswer:
      'I start each morning 15 minutes before my shift to review urgent messages, check my task board, and rank my top three priorities. If I run into unclear instructions while my manager is offline, I first check our standard operating procedures and past tickets for context. I then send a structured message stating the issue, the two best options I see, and which option I am proceeding with in the meantime so work never comes to a complete halt. For technical issues, I maintain a mobile hotspot backup and immediately notify the team channel if any system outage occurs.',
  },
  {
    id: 'ih-3',
    phaseNumber: 3,
    phaseTitle: 'Phase 3: Behavioral & Situational STAR Method',
    sourcePage: 'interview-helper',
    sourceUrl: 'https://www.globalhire360.com/interview-helper/',
    question:
      'Tell me about a time when you had a miscommunication, a difficult client conversation, or a tight competing deadline. What was the situation, what action did you take, and what was the result?',
    whyWeAsk:
      'Tests your ability to use the STAR method (Situation, Task, Action, Result) and remain calm, polite, and solution-focused under pressure.',
    whatGoodLooksLike: [
      'Clearly outlines the Situation and Task without blaming others',
      'Details specific, professional Actions taken to resolve the gap',
      'Shares a measurable or concrete positive Result',
    ],
    recommendedFramework: 'STAR Method (Situation · Task · Action · Result)',
    sampleStrongAnswer:
      'In my previous role (Situation), an international client was upset because a monthly report they expected by 9:00 AM their time was delayed due to a timezone misunderstanding on our team (Task). I immediately joined a quick call to listen, acknowledged their frustration calmly without making excuses, and delivered the priority summary within 30 minutes while completing the full audit two hours later (Action). Afterward, I created a shared timezone checklist for all client deliverables, which eliminated late handoffs for the entire quarter and earned a 5-star review from that client (Result).',
  },
  {
    id: 'cw-1',
    phaseNumber: 4,
    phaseTitle: 'Phase 4: Candidate Workshop & Platform Readiness',
    sourcePage: 'candidate-workshop',
    sourceUrl: 'https://www.globalhire360.com/candidate-workshop/',
    question:
      'Based on the Global Hire 360 Candidate Workshop, how do you maintain your profile eligibility, handle dashboard status updates (such as Matching vs. Not Matching), and follow platform security rules?',
    whyWeAsk:
      'Verifies that you understand how Global Hire 360 operates as a direct staffing agency, how onboarding works, and how to conduct yourself professionally in the candidate community.',
    whatGoodLooksLike: [
      'Understands that "NOT MATCHING" means not currently under active review—not a rejection—and knows to contact support if status reverts after an interview',
      'Confirms clicking "Mark Complete" on all Workforce English lessons and keeping profile/ID strictly in the private verification portal (never in group chats)',
      'Demonstrates readiness to respond promptly and professionally when a "MATCHED" opportunity appears on the dashboard',
    ],
    recommendedFramework: 'Compliance – Dashboard Literacy – Professional Conduct',
    sampleStrongAnswer:
      'I understand that Global Hire 360 is a direct staffing and talent-matching agency rather than an open job board. To stay 100% match-ready, I make sure every lesson in the Workforce English certification is explicitly marked complete, my government ID is uploaded only inside the secure verification section of my dashboard—never in public group chats—and I check my candidate portal daily. I also know that "Not Matching" is not a rejection, whereas "Matching" means my profile is under review, and if I receive a "Matched" status or recruiter message, I will respond promptly and follow all dashboard instructions.',
  },
];

export const ROLE_TRACKS: RoleTrack[] = [
  {
    id: 'customer-service',
    title: 'Customer Service & Support Specialist',
    courseSlug: 'customer-service-assessment',
    summary: 'Inbound/outbound support agents, live chat representatives, and helpdesk specialists.',
    typicalDuties: 'Handling customer inquiries via phone, email, and live chat, de-escalating frustrated clients, logging tickets in CRM systems, and maintaining high first-contact resolution.',
    keySkills: ['De-escalation', 'Live Chat & Voice Clarity', 'CRM Ticketing', 'Empathy & Patience', 'First-Contact Resolution'],
    roleQuestions: [
      {
        id: 'role-cs-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (Customer Service)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'A customer contacts you upset because they were billed twice and demands an immediate refund, which requires supervisor approval. How do you handle the conversation from start to finish?',
        whyWeAsk:
          'Assesses your Workplace English tone, empathy, policy adherence, and ability to reassure an international customer without making promises you cannot keep.',
        whatGoodLooksLike: [
          'Validates the customer’s frustration immediately with warm, polite language',
          'Verifies the account details and explains the exact next step and timeline transparently',
          'Follows up proactively until the billing issue is confirmed resolved',
        ],
        recommendedFramework: 'Acknowledge – Investigate – Set Clear Timeline – Follow Through',
        sampleStrongAnswer:
          'First, I would thank the customer for bringing this to my attention and sincerely apologize for the stress caused by a duplicate charge. While pulling up their billing record, I would confirm both transaction IDs so they know I am taking immediate action. I would then explain clearly that I have submitted an urgent priority refund request to my supervisor, give them the exact ticket reference number, and let them know I will personally email them an update within two hours so they do not have to call back.',
      },
    ],
  },
  {
    id: 'admin-ea',
    title: 'Administrative & Executive Assistant (EA)',
    courseSlug: 'administrative-and-organizational-skills-assessment',
    summary: 'Executive assistants, calendar managers, data entry operators, and virtual office coordinators.',
    typicalDuties: 'Managing complex multi-timezone calendars, inbox triage, preparing executive briefs, maintaining accurate spreadsheets, and coordinating travel or client meetings.',
    keySkills: ['Calendar & Timezone Management', 'Inbox Triage', 'Data Accuracy', 'Confidentiality', 'Executive Written English'],
    roleQuestions: [
      {
        id: 'role-ea-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (Administrative & EA)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'Your executive has two urgent client meetings double-booked at 2:00 PM EST, and a 500-row spreadsheet audit is due by 4:00 PM EST. How do you handle this situation?',
        whyWeAsk:
          'Evaluates organizational judgment, priority triage, and how you communicate calendar conflicts professionally to senior stakeholders.',
        whatGoodLooksLike: [
          'Assesses which meeting has higher business urgency or flexibility',
          'Proposes concrete alternative time slots before reaching out to reschedule',
          'Communicates clearly with the executive on progress for the 4:00 PM deliverable',
        ],
        recommendedFramework: 'Triage Urgency – Propose Solutions – Execute Cleanly',
        sampleStrongAnswer:
          'I would immediately check the context of both 2:00 PM meetings—such as whether one is a new client pitch and the other is a routine check-in—and find two open reschedule slots on the calendar. I would send my executive a concise message recommending which meeting to keep and offering to move the other right away. Once the calendar conflict is settled within 10 minutes, I would block uninterrupted focus time to complete and double-check the 500-row spreadsheet audit well before the 4:00 PM EST deadline.',
      },
    ],
  },
  {
    id: 'it-tech',
    title: 'IT & Technical Support Specialist (Tier 1 & 2)',
    courseSlug: 'it-technical-assessment',
    summary: 'Tier 1 & Tier 2 helpdesk engineers, software troubleshooting specialists, and remote systems support.',
    typicalDuties: 'Diagnosing hardware/software issues remotely, guiding non-technical users through step-by-step fixes, managing access permissions, and escalating complex bugs with clean logs.',
    keySkills: ['Remote Diagnostics', 'Plain-English Tech Explanation', 'Ticket Documentation', 'Access & Security Protocols', 'SLA Management'],
    roleQuestions: [
      {
        id: 'role-it-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (IT & Technical Support)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'How do you guide a non-technical remote employee through fixing a connectivity or software access issue when they are frustrated and unfamiliar with technical terms?',
        whyWeAsk:
          'Tests whether you can translate technical troubleshooting into simple, patient, step-by-step instructions over a remote call or chat.',
        whatGoodLooksLike: [
          'Avoids jargon and gives one clear instruction at a time',
          'Confirms what the user sees on their screen at each step',
          'Documents the root cause and resolution clearly in the helpdesk ticket',
        ],
        recommendedFramework: 'Reassure – Isolate One Step at a Time – Verify & Document',
        sampleStrongAnswer:
          'I start by reassuring the user that we will get them back up and running step by step. Instead of using technical terms like DNS cache or VPN tunnel, I use simple visual landmarks on their screen—for example, asking them to look at the bottom-right corner by the clock and tell me what icon they see. I give one instruction at a time, confirm it worked before moving to the next, and once resolved, I summarize the fix in plain English and log the technical details in the ticket.',
      },
    ],
  },
  {
    id: 'sales-leadgen',
    title: 'Sales & Lead Generation Specialist',
    courseSlug: 'sales-and-lead-generation-assessment',
    summary: 'Outbound SDRs, appointment setters, lead qualification specialists, and pipeline coordinators.',
    typicalDuties: 'Prospecting qualified leads, conducting outbound discovery calls and emails, overcoming objections politely, booking meetings for account executives, and updating CRM pipelines.',
    keySkills: ['Consultative Discovery', 'Objection Handling', 'CRM Hygiene', 'Cold Outreach & Follow-Up', 'Active Listening'],
    roleQuestions: [
      {
        id: 'role-sales-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (Sales & Lead Generation)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'When reaching out to a busy business owner who says "We are already happy with our current provider and don’t have time right now," how do you respond?',
        whyWeAsk:
          'Evaluates poise, consultative curiosity, respectful objection handling, and clarity of spoken English.',
        whatGoodLooksLike: [
          'Respects the prospect’s time without sounding pushy or defensive',
          'Pivots with a short, value-focused question or offers a low-friction follow-up',
          'Logs accurate notes in the CRM for future nurturing',
        ],
        recommendedFramework: 'Acknowledge – Pivot with Value – Low-Friction Next Step',
        sampleStrongAnswer:
          'I would respond warmly: "I completely understand, and it is great to hear you already have a solid setup in place. Many of the teams we support felt the same way until they used our workflow to cut their weekly processing time by 30% alongside their existing provider. Would you be open to me sending a 60-second comparison summary by email, and if it is relevant, we can chat for 10 minutes next Tuesday?"',
      },
    ],
  },
  {
    id: 'creative-digital',
    title: 'Creative & Digital Marketing Specialist',
    courseSlug: 'creative-digital-skills-assessment',
    summary: 'SEO specialists, social media managers, email campaign coordinators, and content producers.',
    typicalDuties: 'Planning content calendars, optimizing web pages for search, executing email campaigns, tracking engagement metrics, and aligning creative assets with brand voice.',
    keySkills: ['Content Strategy', 'SEO & Analytics', 'Email Campaigns', 'Brand Voice Consistency', 'Deadline Execution'],
    roleQuestions: [
      {
        id: 'role-cd-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (Creative & Digital Skills)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'How do you approach creating a digital campaign (social media, email, or SEO content) for an international brand, and how do you measure whether it succeeded?',
        whyWeAsk:
          'Checks that you combine creative execution with measurable business outcomes and clear client reporting.',
        whatGoodLooksLike: [
          'Starts with target audience and brand voice alignment',
          'Tracks concrete KPIs (click-through rate, conversion rate, organic traffic, qualified leads)',
          'Explains how to iterate when a campaign underperforms',
        ],
        recommendedFramework: 'Goal & Audience – Execution – KPI Measurement & Iteration',
        sampleStrongAnswer:
          'I begin by reviewing the client’s brand guidelines, target customer persona, and primary conversion goal. Before launching a full campaign, I draft clear copy with a single call-to-action and test two subject lines or visual hooks. After launch, I track open rates, click-through rates, and actual lead conversions—not just vanity likes—and share a simple weekly performance summary showing what worked and what we are optimizing next.',
      },
    ],
  },
  {
    id: 'accounting-bookkeeping',
    title: 'Accounting & Bookkeeping Specialist',
    courseSlug: 'accounting-bookkeeping',
    summary: 'Remote bookkeepers, accounts payable/receivable specialists, and financial record auditors.',
    typicalDuties: 'Reconciling bank statements, managing AP/AR invoicing, categorizing transactions in QuickBooks/Xero, preparing month-end summaries, and flagging discrepancies.',
    keySkills: ['Bank Reconciliation', 'QuickBooks / Xero / Excel', 'AP & AR Accuracy', 'Financial Confidentiality', 'Discrepancy Investigation'],
    roleQuestions: [
      {
        id: 'role-acc-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (Accounting & Bookkeeping)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'During a month-end reconciliation, you notice a recurring discrepancy between vendor invoices and bank ledger entries. Walk us through how you investigate and report it.',
        whyWeAsk:
          'Evaluates attention to detail, structured audit habits, and ability to explain financial findings clearly to business owners.',
        whatGoodLooksLike: [
          'Cross-checks source documents (invoices, receipts, payment logs) systematically',
          'Never guesses or forces a reconciliation balance',
          'Presents the finding clearly with supporting documentation and recommended correction',
        ],
        recommendedFramework: 'Verify Source Docs – Isolate Variance – Report with Evidence',
        sampleStrongAnswer:
          'First, I compare the bank statement lines against the original vendor invoices and payment confirmations to see if the variance comes from foreign exchange fees, duplicate entries, or an unrecorded credit memo. I never force a reconciliation plug. Once I isolate the exact transactions causing the gap, I document them in a clean summary table with invoice attachments and present the exact adjustment needed for the controller or business owner to approve.',
      },
    ],
  },
  {
    id: 'healthcare-care',
    title: 'Healthcare & Specialized Care Coordinator',
    courseSlug: 'healthcare-and-specialized-care-assessment',
    summary: 'Remote patient intake coordinators, medical administrative assistants, and care scheduling specialists.',
    typicalDuties: 'Coordinating patient appointments, verifying insurance/intake documentation, handling sensitive inquiries with empathy, and maintaining strict privacy compliance.',
    keySkills: ['Patient Empathy', 'Privacy & Data Compliance', 'Medical Scheduling', 'Accurate Documentation', 'Calm Triage'],
    roleQuestions: [
      {
        id: 'role-hc-1',
        phaseNumber: 5,
        phaseTitle: 'Phase 5: Role-Specific Assessment (Healthcare & Specialized Care)',
        sourcePage: 'role-assessment',
        sourceUrl: 'https://www.globalhire360.com/interview-helper/',
        question:
          'How do you balance compassionate support for an anxious patient or family member while strictly following privacy rules and intake documentation requirements?',
        whyWeAsk:
          'Tests empathy, clear spoken communication, and unwavering commitment to patient data privacy.',
        whatGoodLooksLike: [
          'Uses a calm, reassuring, and respectful tone',
          'Verifies identity before sharing any protected health or scheduling details',
          'Records accurate notes in the care management system',
        ],
        recommendedFramework: 'Compassionate Tone – Identity Verification – Accurate Intake',
        sampleStrongAnswer:
          'When speaking with an anxious patient or family member, I lower my speaking pace and reassure them that I am here to help them step by step. Before discussing any appointment or record details, I politely explain that for their protection I need to verify two identity details first. Once verified, I walk them through the intake or scheduling options clearly, confirm they have no remaining questions, and log all updates accurately in the secure portal.',
      },
    ],
  },
];
