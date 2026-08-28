; The Office Panel needs no inbound firewall rules.
;
; Its server binds 127.0.0.1 only — nothing on the network talks to it. It makes
; outbound connections to the Master and receives the discovery reply on an
; ephemeral port, both of which Windows allows by default. Adding rules here
; would open ports nothing listens on, which is the wrong direction.
;
; The file exists so the two panels' configs stay the same shape; the reasoning
; above is the point of it.

!macro customInstall
!macroend

!macro customUnInstall
!macroend
