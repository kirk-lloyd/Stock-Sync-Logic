import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust this path as needed

/**
 * Action function to update a variant-level metafield.
 * Builds a GraphQL mutation and sets the metafield based on the key.
 * Handles multiple metafield types including parent-master relationships.
 */
export async function action({ request }) {
  // 1) Get the Shopify Admin API client.
  const { admin } = await authenticate.admin(request);
  
  // 2) Parse the request body.
  let { variantId, namespace, key, value, type } = await request.json();
  console.log("update-variant-metafield => Inicio", { variantId, namespace, key, value, type });
  
  try {
    // 3) Build the GraphQL mutation to set a variant-level metafield.
    const mutation = `#graphql
      mutation metafieldsSetVariant($input: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $input) {
          metafields {
            id
            namespace
            key
            value
            ownerType
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    
    // 4) Determine the metafield type based on the key or use provided type.
    let metafieldType = type || "boolean";
    
    // Override type based on known metafields if not explicitly provided
    if (!type) {
      if (key === "master") {
        metafieldType = "boolean";
      } 
      else if (key === "childrenkey") {
        metafieldType = "list.variant_reference";
      } 
      else if (key === "parentmaster") {
        metafieldType = "list.variant_reference";
      }
      else if (key === "qtymanagement" || key === "qtyold") {
        metafieldType = "number_integer";
      }
    }
    
    // 5) Process the value based on the metafield type
    let processedValue = value;
    
    if (metafieldType === "boolean") {
      // No convierta a boolean de JavaScript, sino mantenga como string
      processedValue = (value === true || value === "true") ? "true" : "false";
      console.log(`Procesando valor booleano: ${value} -> ${processedValue}`);
    } 
    else if (metafieldType === "list.variant_reference") {
      // Handle the value formatting for list.variant_reference
      if (!value || value === '') {
        // Empty array for clearing the reference
        processedValue = JSON.stringify([]);
      } else if (Array.isArray(value)) {
        // Stringify the array
        processedValue = JSON.stringify(value);
      } else if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
        // Already JSON string, validate and use as is
        try {
          JSON.parse(value); // Just to validate
          processedValue = value;
        } catch (e) {
          console.error("Invalid JSON string:", value);
          throw new Error(`Invalid JSON format for ${key}: ${e.message}`);
        }
      } else {
        // Single value, wrap in array
        processedValue = JSON.stringify([value]);
      }
      console.log(`Procesando valor list.variant_reference: ${JSON.stringify(value)} -> ${processedValue}`);
    }
    else if (metafieldType === "number_integer") {
      try {
        // Ensure the value is a valid integer
        const numValue = typeof value === 'string' ? parseFloat(value) : Number(value);
        // Apply Math.floor to ensure it's an integer and convert to string
        const intValue = Math.floor(numValue);
        
        if (isNaN(intValue)) {
          throw new Error(`Invalid number: ${value}`);
        }
        
        // Convert to string for Shopify
        processedValue = String(intValue);
        console.log(`Procesando valor number_integer: ${value} -> ${processedValue}`);
      } catch (e) {
        console.error("Error processing number_integer:", e);
        throw new Error(`Error processing ${key} as number_integer: ${e.message}`);
      }
    }
    
    // 6) Prepare variables for the mutation.
    const variables = {
      input: [
        {
          ownerId: variantId,
          namespace,
          key,
          value: processedValue,
          type: metafieldType,
        },
      ],
    };
    
    console.log(`Enviando a Shopify - Tipo: ${metafieldType}, Valor procesado:`, processedValue);
    
    // 7) Send the GraphQL request.
    const response = await admin.graphql(mutation, { variables });
    const data = await response.json();
    
    // 8) Check for user errors from Shopify.
    if (data?.data?.metafieldsSet?.userErrors?.length) {
      const errors = data.data.metafieldsSet.userErrors;
      console.error("Shopify metafieldsSet userErrors:", errors);
      
      // Detalle adicional del error para debug
      console.error(`Detalles completos: Tipo=${metafieldType}, Valor=${processedValue}, Variables=`, variables);
      
      return json({ 
        success: false, 
        errors,
        details: {
          type: metafieldType,
          processedValue,
          originalValue: value
        }
      }, { status: 400 });
    }
    
    console.log(
      "Successfully updated variant metafield:",
      data?.data?.metafieldsSet?.metafields
    );
    
    // 9) Return success.
    return json({
      success: true,
      metafields: data?.data?.metafieldsSet?.metafields || [],
    });
  } catch (error) {
    console.error("Error en /api/update-variant-metafield action:", error);
    return json({ 
      success: false, 
      error: error.message,
      details: {
        namespace,
        key,
        value,
        providedType: type
      }
    }, { status: 500 });
  }
}