; Firewall rules for the Master Panel.
;
; Without these Windows prompts on first run — and if whoever is standing there
; clicks "Cancel", panel discovery silently stops working with no error anyone
; can see. TCP 4100 is the API and socket every panel syncs through; UDP 45789
; is the discovery broadcast that lets a panel find this Master without anybody
; typing an IP address (shared/src/protocol/discovery.ts).
;
; Removed on uninstall: a rule for software that is gone is a hole nobody is
; watching.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall add rule name="OrderBook Master (TCP 4100)" dir=in action=allow protocol=TCP localport=4100'
  nsExec::Exec 'netsh advfirewall firewall add rule name="OrderBook Discovery (UDP 45789)" dir=in action=allow protocol=UDP localport=45789'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="OrderBook Master (TCP 4100)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="OrderBook Discovery (UDP 45789)"'
!macroend
