---- MODULE delivery ----
EXTENDS Naturals, FiniteSets

CONSTANTS Design, SlowSenders

Crons == {"cron1", "cron2"}
Requests == {"first", "again"}
Senders == Crons \cup Requests
None == "none"

VARIABLES delivered, due, okRecorded, leaseOwner, claim, pc

vars == <<delivered, due, okRecorded, leaseOwner, claim, pc>>

Init ==
    /\ delivered = FALSE
    /\ due = FALSE
    /\ okRecorded = FALSE
    /\ leaseOwner = None
    /\ claim = None
    /\ pc = [s \in Senders |-> IF s = "again" THEN "waiting" ELSE "ready"]

Eligible(s) == ~delivered /\ (s \in Crons => due)

Claims == Design \in {"claim", "claim-nofence"}

Applies(s) == ~(Design = "claim") \/ claim = s

Claim(s) ==
    /\ pc[s] = "ready"
    /\ CASE Design = "select" ->
              /\ pc' = [pc EXCEPT ![s] = IF Eligible(s) THEN "claimed" ELSE "done"]
              /\ UNCHANGED <<delivered, due, okRecorded, leaseOwner, claim>>
         [] Design = "lease" ->
              /\ pc' = [pc EXCEPT ![s] = IF Eligible(s) THEN "claimed" ELSE "done"]
              /\ due' = IF Eligible(s) THEN FALSE ELSE due
              /\ leaseOwner' = IF Eligible(s) THEN s ELSE leaseOwner
              /\ UNCHANGED <<delivered, okRecorded, claim>>
         [] Claims ->
              /\ pc' = [pc EXCEPT ![s] = IF Eligible(s) /\ claim = None THEN "claimed" ELSE "done"]
              /\ claim' = IF Eligible(s) /\ claim = None THEN s ELSE claim
              /\ UNCHANGED <<delivered, due, okRecorded, leaseOwner>>

Send(s) ==
    /\ pc[s] = "claimed"
    /\ pc' = [pc EXCEPT ![s] = "sending"]
    /\ UNCHANGED <<delivered, due, okRecorded, leaseOwner, claim>>

Record(s, ok) ==
    /\ pc[s] = "sending"
    /\ pc' = [pc EXCEPT ![s] = "done"]
    /\ delivered' = IF Applies(s) THEN ok ELSE delivered
    /\ okRecorded' = (okRecorded \/ (ok /\ Applies(s)))
    /\ due' = IF Applies(s) THEN due /\ ok ELSE due
    /\ claim' = IF claim = s THEN None ELSE claim
    /\ leaseOwner' = IF leaseOwner = s THEN None ELSE leaseOwner

Accepted(s) == Record(s, TRUE)
Rejected(s) == Record(s, FALSE)

Crash(s) ==
    /\ pc[s] \in {"claimed", "sending"}
    /\ pc' = [pc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<delivered, due, okRecorded, leaseOwner, claim>>

ClaimExpires ==
    /\ claim # None
    /\ SlowSenders \/ pc[claim] = "done"
    /\ claim' = None
    /\ UNCHANGED <<delivered, due, okRecorded, leaseOwner, pc>>

SendAgain ==
    /\ pc["again"] = "waiting"
    /\ pc' = [pc EXCEPT !["again"] = "ready"]
    /\ delivered' = FALSE
    /\ due' = FALSE
    /\ okRecorded' = FALSE
    /\ leaseOwner' = None
    /\ UNCHANGED claim

TimePasses ==
    /\ ~due
    /\ ~delivered
    /\ \A r \in Requests : pc[r] # "ready"
    /\ IF leaseOwner = None THEN TRUE ELSE pc[leaseOwner] = "done"
    /\ due' = TRUE
    /\ leaseOwner' = None
    /\ UNCHANGED <<delivered, okRecorded, claim, pc>>

Next ==
    \/ \E s \in Senders : Claim(s) \/ Send(s) \/ Accepted(s) \/ Rejected(s) \/ Crash(s)
    \/ SendAgain
    \/ ClaimExpires
    \/ TimePasses

Spec == Init /\ [][Next]_vars

NoConcurrentSends == Cardinality({s \in Senders : pc[s] = "sending"}) <= 1

DeliveredStaysDelivered == okRecorded => delivered

====
