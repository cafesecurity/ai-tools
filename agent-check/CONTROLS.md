# Controls: turning "not this one, not yet" into "yes"

The answer to "can I have one?" is yes on four terms, plus two conditions that depend on what the agent can reach. These are the controls that close each one, marked as policy and process (rules and routines people follow) or technical (settings and tools that enforce it). The same list appears in the tool, filtered to whatever is missing for the agent you describe.

Current as of November 2026. A thinking aid, not an assessment of any product, and not legal or compliance advice.

## Term 1: put it on a plan the company controls

*Policy and process.* A personal account has no contract covering your data and no administrator.

- Ask the vendor whether a business or enterprise plan exists for this assistant. Where none does yet, the answer stays "not this one, not yet".
- Check the contract covers your data: where it is kept, who can see it, and whether it trains models.
- Confirm administrators can see the agent, limit what it connects to, and switch it off.
- Until then, stop it being granted access: restrict which third-party apps staff can connect to company accounts in your Google or Microsoft admin console.
- Or bring the job home: run an equivalent agent on a computer you manage.

## Term 2: cut its access to what the job needs

*Technical.* The less it can reach, the less a planted instruction can take.

- Write down the job in one sentence, then remove every connection that sentence does not need.
- Scope each connection: one mailbox, folder or project, not everything the person can open.
- Use read-only access wherever reading is enough.
- Where the product allows it, give the agent its own identity with its own permissions instead of the person's.
- Keep payments and other money-moving systems out unless moving money is the job.
- Remove connections it has not used when you next review it.

## Term 3: connect it only to servers on your list

*Technical.* Every tool is something the agent reads and a way for data to leave.

- Keep a short approved list of MCP servers and connectors, each with an owner.
- Enforce the list where you can: the agent app's admin allowlist, or a gateway all tool traffic passes through.
- For an unvetted server: remove it, or vet it. Who runs it, what does it read, where does the data go, who can change it?
- Treat a changed tool description as a change to the agent's instructions and review it again. Ask whether your gateway re-checks descriptions, or only the list.
- Scan agent configurations for risky tool combinations once you have more than a handful.
- Check your suppliers' admin consoles for MCP servers they now run on your data, and their defaults.

## Term 4: give it an owner and a date

*Policy and process.* An approval is a photograph. Someone has to look again.

- Name a person, not a department.
- Set the date you look again: a quarter at most, and whenever its tools change.
- On that date, repeat this count and update "last checked".
- Add agents to the mover and leaver checklist: revoke what the agent was granted, hand it over or shut it down, and check what the shutdown leaves behind.

## When all three lamps are lit: dim a lamp, or put a person in the loop

*Technical.* With all three lit, one planted instruction can read sensitive data and send it out.

- Dim untrusted input: keep unvetted tools and outside content out of the session that holds sensitive data.
- Dim sensitive data: narrow what it can see until what is left would not hurt to lose.
- Dim acts or sends: sending to new recipients, paying, and changing records each need a person.
- Make approvals cover edits to records, not only "send" and "pay". Approvals guard verbs.
- Prefer boundaries to prompts: a sandbox or an allowed-destinations list means fewer approvals, and each one gets read.

## When it can reach payments: put bank-detail changes behind a call-back

*Policy and process.* Changing a record is quieter than making a payment, and just as costly.

- Any change to a supplier's bank details needs a person, and a call-back to a number you already hold.
- Give the agent read-only access to supplier records.
- Hold the first payment to changed details for a second approver.
- Agree in advance who rings the bank if money moves: the first hour matters.

## Also worth fixing: get the audit log into your hands

*Technical.* Not a term for "yes", but without it a bad day cannot be reconstructed.

- Ask the vendor what it records, for how long, and how you get it.
- Where an export exists, send it to your own log store.
- Keep your own logs at the systems the agent touches: your search tool, mail, and payments.
