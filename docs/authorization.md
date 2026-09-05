# Authorization policy

Authentication proves control of an eligible school identity. Authorization is separate and comes from the member profile in DynamoDB.

| Capability | Member | Reservation Designee | Treasurer | Vice President | President |
|---|---:|---:|---:|---:|---:|
| Edit own profile / upload avatar | Yes | Yes | Yes | Yes | Yes |
| Create project/team | Yes | Yes | Yes | Yes | Yes |
| Manage own project/team members | Yes | Yes | Yes | Yes | Yes |
| Request membership / respond to invites | Yes | Yes | Yes | Yes | Yes |
| RSVP to published events | Yes | Yes | Yes | Yes | Yes |
| Compose newsletter to active opt-ins | No | Yes | Yes | Yes | Yes |
| Reconcile ambiguous newsletter delivery | No | No | No | Yes | Yes |
| Manage all events and RSVP rosters | No | Yes | No | Yes | Yes |
| Manage all projects/teams | No | No | Yes | Yes | Yes |
| Suspend/reactivate member accounts | No | No | No | Yes | Yes |
| Assign club roles | No | No | No | No | Yes |
| Future treasury records | No | No | Yes | No | Yes |

An owner, or an officer with the corresponding global permission, may list requests, accept/reject requests, invite, directly add, remove, revoke invitations, inspect membership audit history, and transfer ownership. Direct addition is limited to an existing active club profile. Ownership can transfer only to an active member of that resource, and a current owner must transfer before leaving or being removed.

Additional rules:

- Any active member may create a project, but an officer with `projects.manage` must publish it.
- Team capacity is enforced for every admission path.
- Archived resources cannot admit members; unpublished/archived events cannot accept RSVP changes.
- A Vice President cannot modify a President account.
- A user cannot suspend their own account.
- A suspended user may read `/v1/me`, export `/v1/me/export`, and delete `/v1/me`, but cannot use other protected operations.
- Deletion of a suspended account retains a minimal identity restriction. `ensureMember` rejects that identity before profile creation; deleting the profile does not lift a suspension. The final deletion transaction checks the current status and handle so a concurrent administrative change cannot silently remove the restriction.
- Browser fields and token role/group claims are ignored. Only DynamoDB is authoritative.

The first President is established once with AWS operator credentials after their first sign-in. Thereafter, the President assigns roles through the API.
