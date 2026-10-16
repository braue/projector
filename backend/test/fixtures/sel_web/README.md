Cut from browser captures (HAR) of a real SEL-3350 RTAC (10.42.44.34) and
SEL-2730M switch (10.42.44.12), 2026-09. Session ids and credentials removed.

- rtac_eth02_page.html      ethernet_interface.sel?interface_id=1 (Eth_02, 192.168.10.2/24)
- rtac_eth02_save_body.txt  the browser's save after editing that address to 192.168.10.5/24
- rtac_save_reply.html      ethernet_settings_save.sel's reply
- switch_vlans_before.json  vlan_settings.sel before adding ports 1-5,19 to VLAN 14
- switch_vlans_after.json   ... and after
- switch_save_body.txt      the browser's vlan_view_save.sel body for that change
- switch_port_state.json    update.sel's portState (the switch's 24 ports)

From an RTAC (10.42.44.25) capture of Project Management upload + Activate,
2026-10-02 (the browser's HAR export stripped cookies and the .exp's bytes;
the page's upload_project_auth_token is REDACTED):

- rtac_project_upload_body.txt  POST /api/v1/projects multipart framing (file bytes empty)
- rtac_project_listing.html     project_upload.sel listing with the uploaded .exp
- rtac_activate_polls.json      each distinct GET .../commands/<id> reply, in order
