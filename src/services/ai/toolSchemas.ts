/**
 * toolSchemas.ts — Production AI Tool Definitions (24 Agentic Actions)
 *
 * All tools map to existing production stores and backend pipelines.
 * No duplicate business logic — AI is another consumer of the production system.
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
  requiresAuth: boolean;
  clientSide: boolean; // true = execute in frontend toolExecutor.ts
}

export const AI_TOOLS: ToolDefinition[] = [

  // ─── CART MANAGEMENT ──────────────────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'add_to_cart',
      description: 'Add a verified menu item to the production Zustand cart store. Always resolve exact product details before calling.',
      parameters: {
        type: 'object',
        properties: {
          productId:   { type: 'string', description: 'Product ID from knowledge base or search result' },
          productName: { type: 'string', description: 'Exact product name as listed in the menu' },
          price:       { type: 'number', description: 'Verified base price from KB (discounted if applicable)' },
          size:        { type: 'string', description: 'Size selected from verified available sizes only e.g. Small, Medium, Large' },
          crust:       { type: 'string', description: 'Crust selected from verified available crusts only e.g. Classic Hand Tossed, Cheese Burst' },
          addons:      { type: 'array', items: { type: 'string' }, description: 'Verified addon/topping names only' },
          quantity:    { type: 'number', description: 'Quantity (default 1, must be >= 1)' },
          image:       { type: 'string', description: 'Product image URL from KB (optional)' },
          isVegetarian: { type: 'boolean', description: 'Whether item is vegetarian' },
        },
        required: ['productName', 'price'],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'remove_from_cart',
      description: 'Remove a specific item from the cart by product name or item ID.',
      parameters: {
        type: 'object',
        properties: {
          itemId:      { type: 'string', description: 'Cart item ID (if known)' },
          productName: { type: 'string', description: 'Product name in cart to remove' },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'update_quantity',
      description: 'Update quantity of a specific item in the cart.',
      parameters: {
        type: 'object',
        properties: {
          itemId:      { type: 'string', description: 'Cart item ID' },
          productName: { type: 'string', description: 'Product name in cart' },
          action:      { type: 'string', enum: ['increase', 'decrease', 'set_quantity', 'remove'], description: 'Update action type' },
          quantity:    { type: 'number', description: 'New quantity if action is set_quantity (must be >= 1)' },
        },
        required: ['action'],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'clear_cart',
      description: 'Clear all items from the cart. Ask user for confirmation before calling this.',
      parameters: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Must be true — user confirmed clearing cart' },
        },
        required: ['confirmed'],
      },
    },
  },

  // ─── MENU SEARCH ──────────────────────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: false,
    clientSide: false,
    function: {
      name: 'search_menu',
      description: 'Search Olive Pizza menu items with verified details, prices, availability, and nutritional info.',
      parameters: {
        type: 'object',
        properties: {
          query:    { type: 'string', description: 'Search term e.g. paneer pizza, spicy, cheesy garlic bread' },
          category: { type: 'string', description: 'Optional category filter e.g. pizza, sides, beverages, dessert' },
          isVeg:    { type: 'boolean', description: 'Filter vegetarian items only' },
          maxPrice: { type: 'number', description: 'Maximum price filter in INR' },
        },
        required: ['query'],
      },
    },
  },

  // ─── NAVIGATION ───────────────────────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_product',
      description: 'Open a specific product page or product detail modal.',
      parameters: {
        type: 'object',
        properties: {
          productId:   { type: 'string', description: 'Product ID' },
          productName: { type: 'string', description: 'Product name' },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_category',
      description: 'Navigate to a specific menu category page e.g. Pizzas, Beverages, Desserts.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Category name e.g. pizza, beverages, garlic bread, desserts, combos' },
        },
        required: ['category'],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_cart',
      description: 'Open the cart drawer or navigate to the cart page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_offers',
      description: 'Open the offers and deals page showing current promotions and coupons.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_contact',
      description: 'Open the contact / support page for the restaurant.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_assistant',
      description: 'Open or focus the AI assistant interface.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    requiresAuth: true,
    clientSide: true,
    function: {
      name: 'open_profile',
      description: 'Open the customer profile page to view or edit personal details, addresses, and preferences.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    requiresAuth: true,
    clientSide: true,
    function: {
      name: 'open_settings',
      description: 'Open the account settings page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'open_help',
      description: 'Open the help center or FAQ page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },



  // ─── COUPON MANAGEMENT ────────────────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'apply_coupon',
      description: 'Validate and apply a coupon code to the cart/checkout.',
      parameters: {
        type: 'object',
        properties: {
          couponCode: { type: 'string', description: 'Coupon code e.g. OLIVE50, WELCOME100, FIRSTORDER' },
        },
        required: ['couponCode'],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: false,
    clientSide: true,
    function: {
      name: 'remove_coupon',
      description: 'Remove the currently applied coupon from the cart/checkout.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // ─── ORDER MANAGEMENT ─────────────────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: true,
    clientSide: false,
    function: {
      name: 'track_order',
      description: 'Fetch real-time status and delivery tracking for the user\'s current or recent order.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Specific Order ID (optional — fetches latest active order if omitted)' },
        },
        required: [],
      },
    },
  },



  {
    type: 'function',
    requiresAuth: true,
    clientSide: true,
    function: {
      name: 'cancel_order',
      description: 'Navigate to the order details page to initiate order cancellation. NOTE: Only navigate — never auto-cancel silently.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Order ID to cancel' },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: true,
    clientSide: true,
    function: {
      name: 'rate_order',
      description: 'Open the order rating screen for the user to leave feedback for a delivered order.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'Completed Order ID to rate' },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    requiresAuth: true,
    clientSide: true,
    function: {
      name: 'view_order_history',
      description: 'Navigate to the order history page to show the user all their past orders.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // ─── LOCATION ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: true,
    clientSide: true,
    function: {
      name: 'set_live_location',
      description: 'Open the interactive 3D Location Picker flow for delivery address selection.',
      parameters: {
        type: 'object',
        properties: {
          addressHint: { type: 'string', description: 'Optional landmark or area suggestion' },
        },
        required: [],
      },
    },
  },

  // ─── PRODUCT DETAILS (SERVER-SIDE) ────────────────────────────────────────
  {
    type: 'function',
    requiresAuth: false,
    clientSide: false,
    function: {
      name: 'get_product_details',
      description: 'Fetch verified product details including exact sizes, crusts, addons, price, and availability from the production database.',
      parameters: {
        type: 'object',
        properties: {
          productId:   { type: 'string', description: 'Product ID' },
          productName: { type: 'string', description: 'Product name if ID is unknown' },
        },
        required: [],
      },
    },
  },
];

export const TOOL_SCHEMAS_OPENAI = AI_TOOLS.map(t => ({
  type: t.type,
  function: t.function,
}));

export function isAuthRequiredForTool(toolName: string): boolean {
  const tool = AI_TOOLS.find(t => t.function.name === toolName);
  return tool ? tool.requiresAuth : false;
}

export function isClientSideTool(toolName: string): boolean {
  const tool = AI_TOOLS.find(t => t.function.name === toolName);
  return tool ? tool.clientSide : true; // default to client-side for safety
}
