/**
 * The two frames the LeanIX portfolio is projected onto, and the tables that map
 * LeanIX's own capability names into them.
 *
 * This file is the one place to edit when a mapping is wrong. Nothing here is
 * derived at runtime and nothing calls an LLM: a capability map that silently
 * re-classifies itself between page loads is worse than one that is wrong in a
 * way you can see and fix in a diff.
 *
 *   • Business capabilities → the Škoda Auto capability map, generated from
 *     "BusCap_DM to SA mapping.xlsx" into ./data/sa-capability-map.json (see
 *     scripts/import-capability-map.py).
 *   • Technical capabilities → the technology tower model below.
 *
 * Anything a table does not cover is reported as unmapped rather than dropped or
 * guessed — see `resolve*` in ./capability-map.
 */

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Lookup key for a capability name. Folds case, punctuation and spacing, so
 * "No-Code / Low-Code Application Development" and "no code low code application
 * development" are the same key — LeanIX names are hand-typed and drift in
 * exactly those ways.
 */
export function capabilityKey(name: string | null | undefined): string {
    return (name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Builds a key-indexed lookup from a human-readable table. */
function byKey<T>(table: Record<string, T>): Map<string, T> {
    const map = new Map<string, T>();
    for (const [name, value] of Object.entries(table)) {
        map.set(capabilityKey(name), value);
    }
    return map;
}

// ── Technology towers ───────────────────────────────────────────────────────
//
// Derived from the TBM Taxonomy's Technology Resource Towers layer, and
// deliberately NOT identical to it. Stock TBM mixes two axes: it puts server
// virtualization under Compute (a delivery mechanism for a resource) but
// databases under Platform (a shared service), so "Platform" ends up meaning
// "the platform layer of the other towers" — Compute owned its full execution
// stack while Storage owned only raw capacity. Read down the list, that is
// arbitrary, and it is the first thing an architect notices.
//
// ── The rule these towers follow ───────────────────────────────────────────
//
//   ONE AXIS: a tower is a kind of technology capability, and it owns that
//   capability END TO END — from raw resource up to the abstraction an
//   application actually consumes. No tower is the "platform layer" of another.
//
// Applied:
//
//   • Compute owns the whole execution stack: servers, virtualization,
//     containers and orchestration, and language runtimes. All four are ways of
//     getting code executed.
//   • Data & Storage owns the whole persistence stack, symmetrically: raw
//     storage, database platforms, caches, backup, catalog. A database is to
//     storage what a container platform is to a server.
//   • Network owns connectivity between endpoints; Integration & APIs owns
//     connectivity between *systems*. Different consumers, different tower.
//   • The remaining towers are each a distinct domain at the same altitude —
//     none of them is a layer beneath another.
//
// Sub-tower naming is ours, not TBM's. If you need to reconcile this map with a
// TBM-based cost model, the mapping back is mechanical: Compute's runtime and
// container sub-towers and all of Data & Storage's database sub-towers roll up
// to TBM's Platform tower.
//
// Towers with no factsheet in this workspace (facilities, print/output,
// mainframe) are omitted rather than drawn as permanent empty scaffolding. Add
// one here the moment a factsheet needs it.

export interface TechnologyTower {
    name: string;
    description: string;
    subTowers: string[];
}

export const TECHNOLOGY_TOWERS: TechnologyTower[] = [
    {
        name: 'Compute',
        description:
            'Getting code executed — from the machine, through virtualization and containers, up to the language runtime.',
        subTowers: [
            'Servers & Virtualization',
            'Containers & Orchestration',
            'Runtime & Execution Environments',
            'Public Cloud Compute'
        ]
    },
    {
        name: 'Data & Storage',
        description:
            'Keeping data and getting it back — raw capacity, the database platforms on top of it, caches, and the record of what is where.',
        subTowers: [
            'Block, File & Object Storage',
            'Database Platforms',
            'Caching & In-Memory Data',
            'Backup & Archive',
            'Data Catalog & Metadata'
        ]
    },
    {
        name: 'Network & Connectivity',
        description: 'Moving bytes between endpoints, and the traffic management in front of them.',
        subTowers: ['LAN & WAN', 'Load Balancing & Traffic Management', 'Voice & Telephony', 'Public Cloud Network']
    },
    {
        name: 'Integration & APIs',
        description: 'Moving data between systems — the application-level counterpart to the network tower.',
        subTowers: ['API Management', 'Messaging & Events', 'File Transfer', 'Integration Platforms']
    },
    {
        name: 'Analytics & AI',
        description: 'Turning data into information — reporting, models, and the extraction of meaning from documents and media.',
        subTowers: ['Analytics & Reporting', 'Machine Learning & AI', 'Document & Media Intelligence']
    },
    {
        name: 'Application Development & Delivery',
        description: 'Building and shipping software: what developers write with, store code in, and release through.',
        subTowers: [
            'Languages & Frameworks',
            'Source & Artifact Management',
            'CI/CD & DevOps Tooling',
            'Quality & Test'
        ]
    },
    {
        name: 'Business Applications & Automation',
        description: 'Packaged capability the business consumes directly, rather than builds on.',
        subTowers: [
            'Process Automation',
            'Content Management & Search',
            'Engineering & Visualization',
            'Learning & Enablement'
        ]
    },
    {
        name: 'Workplace & Collaboration',
        description: 'What reaches a person at a desk.',
        subTowers: ['Collaboration', 'Chat & Messaging', 'Email', 'Knowledge & Wiki', 'End User Devices']
    },
    {
        name: 'Security & Identity',
        description: 'Who may do what, what guards the edge, and where the secrets live.',
        subTowers: [
            'Identity & Access Management',
            'Perimeter & Application Security',
            'Secrets & Key Management',
            'Security Operations'
        ]
    },
    {
        name: 'IT Operations & Service Management',
        description: 'Running the estate: seeing it, servicing it, and knowing what is in it.',
        subTowers: ['Monitoring & Observability', 'Service Desk & Ticketing', 'Asset & Service Catalog']
    }
];

export interface TechnicalPlacement {
    tower: string;
    subTower: string;
}

/**
 * LeanIX TechnologyStack factsheet name → tower / sub-tower.
 *
 * Keyed on the names present in this workspace (61 of them at the time of
 * writing). A name absent here shows up in the map's "unmapped" panel with its
 * component count, which is the signal to add a line below.
 */
export const TECHNICAL_CAPABILITY_ALIASES: Record<string, TechnicalPlacement> = {
    // ── Compute: the execution stack, end to end ────────────────────────────
    'Compute': { tower: 'Compute', subTower: 'Servers & Virtualization' },
    'Virtualization': { tower: 'Compute', subTower: 'Servers & Virtualization' },
    'Containers': { tower: 'Compute', subTower: 'Containers & Orchestration' },
    'Container Orchestration': { tower: 'Compute', subTower: 'Containers & Orchestration' },
    // A JVM or .NET platform is a way of getting code executed, which is what
    // this tower is for — it is not a shared data service and not an application.
    'Execution & Runtime Environment': { tower: 'Compute', subTower: 'Runtime & Execution Environments' },

    // ── Data & Storage: the persistence stack, symmetrically ────────────────
    'Storage': { tower: 'Data & Storage', subTower: 'Block, File & Object Storage' },
    'Databases': { tower: 'Data & Storage', subTower: 'Database Platforms' },
    'Relational Database': { tower: 'Data & Storage', subTower: 'Database Platforms' },
    'Document Database': { tower: 'Data & Storage', subTower: 'Database Platforms' },
    'NoSQL Database': { tower: 'Data & Storage', subTower: 'Database Platforms' },
    'In-Memory Cache': { tower: 'Data & Storage', subTower: 'Caching & In-Memory Data' },
    'Data Catalog': { tower: 'Data & Storage', subTower: 'Data Catalog & Metadata' },

    // ── Network: endpoint-to-endpoint ───────────────────────────────────────
    'Load Balancing': { tower: 'Network & Connectivity', subTower: 'Load Balancing & Traffic Management' },
    'Reverse Proxy': { tower: 'Network & Connectivity', subTower: 'Load Balancing & Traffic Management' },
    'Forward Proxy': { tower: 'Network & Connectivity', subTower: 'Load Balancing & Traffic Management' },

    // ── Integration: system-to-system ───────────────────────────────────────
    'API Management': { tower: 'Integration & APIs', subTower: 'API Management' },
    'API Catalog': { tower: 'Integration & APIs', subTower: 'API Management' },
    'Messaging': { tower: 'Integration & APIs', subTower: 'Messaging & Events' },
    'File Transfer': { tower: 'Integration & APIs', subTower: 'File Transfer' },

    // ── Analytics & AI ──────────────────────────────────────────────────────
    'Data Analytics': { tower: 'Analytics & AI', subTower: 'Analytics & Reporting' },
    'Data Reporting': { tower: 'Analytics & AI', subTower: 'Analytics & Reporting' },
    'Artificial Intelligence & Machine Learning': { tower: 'Analytics & AI', subTower: 'Machine Learning & AI' },
    'Large Language Modeling': { tower: 'Analytics & AI', subTower: 'Machine Learning & AI' },
    'Natural Language Processing': { tower: 'Analytics & AI', subTower: 'Machine Learning & AI' },
    'Neural Network': { tower: 'Analytics & AI', subTower: 'Machine Learning & AI' },
    'Data Prediction': { tower: 'Analytics & AI', subTower: 'Machine Learning & AI' },
    'OCR & Text Processing': { tower: 'Analytics & AI', subTower: 'Document & Media Intelligence' },
    'Sound Analysis': { tower: 'Analytics & AI', subTower: 'Document & Media Intelligence' },

    // ── Application development & delivery ──────────────────────────────────
    'Application Development': { tower: 'Application Development & Delivery', subTower: 'Languages & Frameworks' },
    'No-Code / Low-Code Application Development': {
        tower: 'Application Development & Delivery',
        subTower: 'Languages & Frameworks'
    },
    'Programming language': { tower: 'Application Development & Delivery', subTower: 'Languages & Frameworks' },
    'Development Framework': { tower: 'Application Development & Delivery', subTower: 'Languages & Frameworks' },
    'Libraries': { tower: 'Application Development & Delivery', subTower: 'Languages & Frameworks' },
    'Source Code Repository': {
        tower: 'Application Development & Delivery',
        subTower: 'Source & Artifact Management'
    },
    'Artifact Repository': { tower: 'Application Development & Delivery', subTower: 'Source & Artifact Management' },
    'Continuous Integration & Continuous Deployment': {
        tower: 'Application Development & Delivery',
        subTower: 'CI/CD & DevOps Tooling'
    },
    'DevOps, Tools & Development': {
        tower: 'Application Development & Delivery',
        subTower: 'CI/CD & DevOps Tooling'
    },
    'Issue Tracking': { tower: 'Application Development & Delivery', subTower: 'CI/CD & DevOps Tooling' },
    'Code Quality & Compliance Scanning': { tower: 'Application Development & Delivery', subTower: 'Quality & Test' },
    'Test Execution & Automation': { tower: 'Application Development & Delivery', subTower: 'Quality & Test' },

    // ── Business applications & automation ──────────────────────────────────
    'Process Automation': { tower: 'Business Applications & Automation', subTower: 'Process Automation' },
    'Robotic Process Automation': { tower: 'Business Applications & Automation', subTower: 'Process Automation' },
    'Content Management': { tower: 'Business Applications & Automation', subTower: 'Content Management & Search' },
    'Search & Indexing': { tower: 'Business Applications & Automation', subTower: 'Content Management & Search' },
    '3D Visualization & Rendering': {
        tower: 'Business Applications & Automation',
        subTower: 'Engineering & Visualization'
    },
    'Learning System': { tower: 'Business Applications & Automation', subTower: 'Learning & Enablement' },

    // ── Workplace ───────────────────────────────────────────────────────────
    'Communication & Collaboration': { tower: 'Workplace & Collaboration', subTower: 'Collaboration' },
    'Chat & Instant messaging': { tower: 'Workplace & Collaboration', subTower: 'Chat & Messaging' },
    'E-Mail': { tower: 'Workplace & Collaboration', subTower: 'Email' },
    'Wiki & Knowledge Base': { tower: 'Workplace & Collaboration', subTower: 'Knowledge & Wiki' },

    // ── Security & identity ─────────────────────────────────────────────────
    'Identity Provider': { tower: 'Security & Identity', subTower: 'Identity & Access Management' },
    'Authorization and Adaptive Access': {
        tower: 'Security & Identity',
        subTower: 'Identity & Access Management'
    },
    'Web Application Firewall': { tower: 'Security & Identity', subTower: 'Perimeter & Application Security' },
    'Secrets Management': { tower: 'Security & Identity', subTower: 'Secrets & Key Management' },
    'Security & Compliance': { tower: 'Security & Identity', subTower: 'Security Operations' },

    // ── IT operations & service management ──────────────────────────────────
    'Infrastructure Monitoring': {
        tower: 'IT Operations & Service Management',
        subTower: 'Monitoring & Observability'
    },
    'Application Performance Management': {
        tower: 'IT Operations & Service Management',
        subTower: 'Monitoring & Observability'
    },
    'Log Aggregation Management': {
        tower: 'IT Operations & Service Management',
        subTower: 'Monitoring & Observability'
    },
    'Ticketing': { tower: 'IT Operations & Service Management', subTower: 'Service Desk & Ticketing' },
    'IT Asset Management': { tower: 'IT Operations & Service Management', subTower: 'Asset & Service Catalog' },
    'Service Catalog': { tower: 'IT Operations & Service Management', subTower: 'Asset & Service Catalog' }
};

// ── Business capabilities ───────────────────────────────────────────────────

export interface BusinessPlacement {
    /** SA level-1 domain. Must match a domain name in sa-capability-map.json. */
    domain: string;
    /** SA level-2 group, when one applies. */
    group?: string;
    /** SA level-3 capability, when one applies. */
    capability?: string;
}

/**
 * LeanIX BusinessCapability factsheet name → a place in the Škoda Auto map.
 *
 * ── Read this before trusting the placements ────────────────────────────────
 * NONE of these names appear in the workbook, at any level. That is not a
 * matching failure: the workbook's detail covers the commercial domains (Sales,
 * Marketing, Partner Network, Customer Management, After Sales, Communication,
 * Product Management, Digital & Mobility Service Provisioning — 218 level-3
 * capabilities), while the Enterprise-tagged applications overwhelmingly support
 * Finance, IT and HR capabilities, and those eight domains are level-1 stubs with
 * no children in the sheet.
 *
 * So the placements below are to the DOMAIN only, assigned by hand from the
 * capability name, and they are the weakest data in the capability map. They are
 * here so the map is not empty, not because they are authoritative. When the
 * IT / Finance / HR branches of the taxonomy exist, extend these entries with
 * `group` and `capability` and the map will deepen without any other change.
 */
export const BUSINESS_CAPABILITY_ALIASES: Record<string, BusinessPlacement> = {
    // ── Finance: planning, closing, controlling, statutory reporting ─────────
    'Area Reporting': { domain: 'Finance' },
    'Budget Management': { domain: 'Finance' },
    'Controlling': { domain: 'Finance' },
    'Corporate IT Controlling': { domain: 'Finance' },
    'After Sales Controlling': { domain: 'Finance' },
    'New Vehicles Sales Controlling': { domain: 'Finance' },
    'New and Digital Services Controlling': { domain: 'Finance' },
    'Sales Costs Controlling': { domain: 'Finance' },
    'Vehicle Production Costs Controlling': { domain: 'Finance' },
    'Production and Logistics Overhead Costs Controlling': { domain: 'Finance' },
    'Financial Closings': { domain: 'Finance' },
    'Fixed Assets Closing': { domain: 'Finance' },
    'Increase and Decrease of Fixed Assets Management': { domain: 'Finance' },
    'Financial Reporting and Analytics': { domain: 'Finance' },
    'Group and Brand Reports': { domain: 'Finance' },
    'Ministry of Finance Reporting Management': { domain: 'Finance' },
    'National Bank Reporting Management': { domain: 'Finance' },
    'Investment Portfolio Management': { domain: 'Finance' },
    'Investment and Lease Planning': { domain: 'Finance' },
    'Short-Term Plan Management': { domain: 'Finance' },
    'Long-Term Plan Preparation': { domain: 'Finance' },
    'Calculate key performance indicator': { domain: 'Finance' },
    'Register key performance indicator': { domain: 'Finance' },
    'Provision analyses & reports': { domain: 'Finance' },

    // ── IT: the architecture, data and service-management capabilities ───────
    'Enterprise Architecture Management': { domain: 'IT' },
    'Architecture Modelling': { domain: 'IT' },
    'Architecture Repository Management': { domain: 'IT' },
    'Manage information architecture': { domain: 'IT' },
    'IT Operations Management': { domain: 'IT' },
    'IT Service Management (general)': { domain: 'IT' },
    'Portfolio Backlog Management': { domain: 'IT' },
    'Security Event Logging': { domain: 'IT' },
    'Search': { domain: 'IT' },
    'Master Data Management': { domain: 'IT' },
    'Meta Data Development': { domain: 'IT' },
    'Data Shopping': { domain: 'IT' },
    'Data Sources Development': { domain: 'IT' },
    'Data Analysis': { domain: 'IT' },
    'Data Analysis Development': { domain: 'IT' },
    'Data Analysis Planning': { domain: 'IT' },
    'Analytics': { domain: 'IT' },
    'Other Traditional Analytics': { domain: 'IT' },

    // ── HR & General Affairs: people, skills, training ──────────────────────
    'Data Driven HR': { domain: 'HR & General Affairs' },
    'HR Digital employee self services': { domain: 'HR & General Affairs' },
    'Services of personnel support': { domain: 'HR & General Affairs' },
    'Conduction of overall skill analysis': { domain: 'HR & General Affairs' },
    'Conduction of training evaluation': { domain: 'HR & General Affairs' },
    'Further training and ecuation controlling and reporting': { domain: 'HR & General Affairs' },

    // ── General Support: legal, risk, compliance, data protection ───────────
    'Legal, Risk & Compliance Management': { domain: 'General Support' },
    'Data protection monitoring (worldwide)': { domain: 'General Support' },
    'Rights of data subjects': { domain: 'General Support' },

    // ── Product / R&D / Sales / Mobility ────────────────────────────────────
    'Product Data Management': { domain: 'Product Management' },
    'Product Design Definition': { domain: 'Research & Development' },
    'Innovation and Idea Management': { domain: 'Research & Development' },
    'Volume Planning': { domain: 'Sales' },
    'Volume Monitoring & Reporting': { domain: 'Sales' },
    'Enabling data-driven decision making for integrated mobility solutions': { domain: 'Digital & Mobility Service' }
};

export const TECHNICAL_ALIAS_INDEX = byKey(TECHNICAL_CAPABILITY_ALIASES);
export const BUSINESS_ALIAS_INDEX = byKey(BUSINESS_CAPABILITY_ALIASES);
