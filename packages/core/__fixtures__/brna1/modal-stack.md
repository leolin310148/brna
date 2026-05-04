# Snapshot · /checkout · iPhone 15 Pro
session: 00000000... · 2026-05-01T12:00:00.000Z

## screen
route: /checkout
title: Checkout
modal_stack: [address-edit]

## tree
- screen#screen-checkout
  - heading "Checkout"
  - modal#address-edit
    - heading "Edit address"
    - input#street-input "Street" = "123 Main St"
    - button#save-btn "Save" [disabled] → tap #save-btn
    - button#cancel-btn "Cancel" → tap #cancel-btn
